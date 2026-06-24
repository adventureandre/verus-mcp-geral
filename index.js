#!/usr/bin/env node

/**
 * verus-mcp-geral v3 — tools de NEGÓCIO consumindo a API do Verus (/ia-dados).
 *
 * v2 fazia SQL read-only direto no Postgres; v3 chama os endpoints do backend
 * Verus, que aplicam a MESMA lógica dos painéis (RCL Anexo 3 com ajustes,
 * DTP/limites da LRF, expurgo RPPS na receita...). A IA responde o mesmo
 * número que a tela mostra, no ambiente certo, sem acesso ao banco.
 *
 * Envs obrigatórias:
 *   VERUS_API_URL   — base da API (ex: https://api.verusvh.com.br)
 *   IA_SERVICE_KEY  — service key das rotas /ia-dados (header X-API-Key)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERUS_API_URL = (process.env.VERUS_API_URL || "").replace(/\/+$/, "");
const IA_SERVICE_KEY = process.env.IA_SERVICE_KEY;
const TIMEOUT_MS = Number(process.env.VERUS_HTTP_TIMEOUT_MS || 20000);

if (!VERUS_API_URL || !IA_SERVICE_KEY) {
  console.error("[verus-mcp-geral] VERUS_API_URL e IA_SERVICE_KEY são obrigatórias");
  process.exit(1);
}

const server = new McpServer({
  name: "verus-mcp-geral",
  version: "3.4.0",
});

function jsonTxt(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

async function apiGet(path, params = {}) {
  const url = new URL(`${VERUS_API_URL}/ia-dados${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  try {
    const res = await fetch(url, {
      headers: { "X-API-Key": IA_SERVICE_KEY },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { success: false, error: body?.error || `Verus API retornou ${res.status}` };
    }
    return body;
  } catch (err) {
    const motivo = err?.name === "TimeoutError" ? "timeout" : (err?.message || "falha de conexão");
    return { success: false, error: `Verus API indisponível (${motivo}). Tente novamente mais tarde.` };
  }
}

const municipioId = z.number().int().describe("municipio_id retornado por resolverMunicipio");
const anoOpt = z.number().int().optional().describe("Ano de referência (default: último com dados)");
const mesOpt = z.number().int().min(1).max(12).optional().describe("Mês de referência (default: último com dados no ano)");

// ========================================
// Tool: resolverMunicipio
// ========================================
server.tool(
  "resolverMunicipio",
  "Resolve o nome de um município para o municipio_id usado pelas demais tools. Retorna só municípios clientes do Verus (com dados). SEMPRE use esta tool primeiro quando o usuário citar um município pelo nome.",
  {
    nome: z.string().min(2).describe("Nome (ou trecho) do município, ex: 'Anápolis'"),
  },
  async ({ nome }) => jsonTxt(await apiGet("/municipios", { nome })),
);

// ========================================
// Tool: getRcl
// ========================================
server.tool(
  "getRcl",
  "Receita Corrente Líquida (RCL, Anexo 3 do RREO) acumulada de janeiro até o mês — mesma fórmula do painel, com deduções e ajustes. Use para perguntas sobre RCL, base de cálculo de limites da LRF.",
  { municipio_id: municipioId, ano: anoOpt, mes: mesOpt },
  async ({ municipio_id, ano, mes }) => jsonTxt(await apiGet("/rcl", { municipio_id, ano, mes })),
);

// ========================================
// Tool: getLimitePessoal
// ========================================
server.tool(
  "getLimitePessoal",
  "Indicador de despesa com pessoal (LRF): DTP, RCL ajustada, percentual e status contra os limites do Executivo municipal (54% máximo, 51,3% prudencial, 48,6% alerta). Use para 'estamos dentro do limite de pessoal?', 'qual o % de pessoal?'.",
  { municipio_id: municipioId, ano: anoOpt, mes: mesOpt },
  async ({ municipio_id, ano, mes }) => jsonTxt(await apiGet("/pessoal", { municipio_id, ano, mes })),
);

// ========================================
// Tool: getReceita
// ========================================
server.tool(
  "getReceita",
  "Receita total arrecadada acumulada no ano (com expurgo RPPS, igual ao card do painel), com comparação ao mesmo período do ano anterior.",
  { municipio_id: municipioId, ano: anoOpt, mes: mesOpt },
  async ({ municipio_id, ano, mes }) => jsonTxt(await apiGet("/receita", { municipio_id, ano, mes })),
);

// ========================================
// Tool: getEducacao
// ========================================
server.tool(
  "getEducacao",
  "Índices de educação do RREO Anexo 8 — mesma apuração do painel: 25% MDE (mínimo constitucional em manutenção e desenvolvimento do ensino) e FUNDEB (70% remuneração, 50% e 15% do VAAT), cada um com valor, mínimo legal e status (cumprido/alerta/descumprido), mais os totais de receita-base, dedução FUNDEB e despesa MDE. Use para 'estamos aplicando os 25% em educação?', 'cumprimos o FUNDEB?', perguntas sobre MDE/educação.",
  { municipio_id: municipioId, ano: anoOpt, mes: mesOpt },
  async ({ municipio_id, ano, mes }) => jsonTxt(await apiGet("/educacao", { municipio_id, ano, mes })),
);

// ========================================
// Tool: getDespesa
// ========================================
server.tool(
  "getDespesa",
  "Despesa total acumulada no ano: empenhado, liquidado e pago (valores líquidos de anulações).",
  { municipio_id: municipioId, ano: anoOpt, mes: mesOpt },
  async ({ municipio_id, ano, mes }) => jsonTxt(await apiGet("/despesa", { municipio_id, ano, mes })),
);

// ========================================
// Tool: getCombustivel
// ========================================
server.tool(
  "getCombustivel",
  "Gastos com combustíveis e lubrificantes (elemento 339030/01) acumulados no ano: empenhado/liquidado/pago, comparação com o ano anterior e top 5 órgãos. Use para 'quanto gastamos com combustível?'.",
  { municipio_id: municipioId, ano: anoOpt, mes: mesOpt },
  async ({ municipio_id, ano, mes }) => jsonTxt(await apiGet("/combustivel", { municipio_id, ano, mes })),
);

// ========================================
// Tool: getSaldosBancarios
// ========================================
server.tool(
  "getSaldosBancarios",
  "Saldo em caixa (saldo final das contas bancárias) do período mais recente com dados — ou de ano/mês específicos. " +
    "Aceita recortes opcionais: por nome de conta (ex.: 'ICMS', 'FPM'), por fonte de recurso, por órgão ou só as contas favoritas do gestor; sem recorte, retorna o total do município. " +
    "Os valores vêm prontos do servidor (não calcule nem some). " +
    "A lista detalhada `por_conta` traz por padrão as 10 maiores contas (use `limite` para pedir mais/menos); os totais e `qtd_contas` são sempre do conjunto completo, independentemente do `limite`. " +
    "Quando a pergunta vier pelo WhatsApp, passe sempre o `telefone` do remetente para o Verus validar a permissão. " +
    "Use para 'quanto temos em caixa?', 'qual o saldo da conta do FPM?', 'saldo das minhas contas favoritas'.",
  {
    municipio_id: municipioId,
    ano: anoOpt,
    mes: mesOpt,
    conta: z.string().optional().describe("Nome (ou trecho) da conta, ex.: 'ICMS', 'FPM'. Match parcial; o servidor soma as contas que casam e informa quantas."),
    fonte: z.string().optional().describe("Código da fonte de recurso para filtrar (ex.: '100')."),
    orgao: z.string().optional().describe("Nome (ou trecho) do órgão, ex.: 'FMAS', 'Fundo Municipal de Saúde'."),
    favoritas: z.boolean().optional().describe("Se true, soma apenas as contas marcadas como favoritas pelo gestor (exige telefone)."),
    telefone: z.string().optional().describe("Telefone do remetente no WhatsApp; o Verus resolve o gestor e valida município/permissão. Obrigatório para o recorte de favoritas."),
    grupo: z.enum(["corrente", "anteriores", "ambos"]).optional().describe("Grupo da fonte: 'corrente' (exercício corrente), 'anteriores' (exercícios anteriores) ou 'ambos' (padrão). Use só quando o gestor pedir explicitamente um grupo; o padrão 'ambos' já traz o total com a decomposição corrente/anterior."),
    limite: z.number().int().min(1).max(100).optional().describe("Quantas contas trazer na lista `por_conta` (maiores saldos primeiro). Padrão 10, máx 100. Não afeta os totais nem `qtd_contas`. Peça poucas (ex.: 3-5) quando o gestor quiser só 'as maiores'; aumente só se ele pedir a lista completa."),
  },
  async ({ municipio_id, ano, mes, conta, fonte, orgao, favoritas, telefone, grupo, limite }) =>
    jsonTxt(await apiGet("/saldos", { municipio_id, ano, mes, conta, fonte, orgao, favoritas, telefone, grupo, limite })),
);

// ========================================
// Tool: getAgenda
// ========================================
server.tool(
  "getAgenda",
  "Obrigações da agenda do município ainda não cumpridas: próximas a vencer e atrasadas (com data limite, área temática e sistema de envio). " +
    "A lista `obrigacoes` traz por padrão as 10 mais próximas (use `limite`); `total_pendentes` é sempre o total do conjunto. " +
    "Use para 'o que vence essa semana?', 'estamos atrasados com algo?'.",
  { municipio_id: municipioId, limite: z.number().int().min(1).max(100).optional().describe("Quantas obrigações trazer na lista (mais próximas primeiro). Padrão 10, máx 100. Não afeta `total_pendentes`.") },
  async ({ municipio_id, limite }) => jsonTxt(await apiGet("/agenda", { municipio_id, limite })),
);

// ========================================
// Tool: getDiligencias
// ========================================
server.tool(
  "getDiligencias",
  "Diligências do TCM-GO em aberto para o município, com número do processo, status e dias restantes do prazo. " +
    "A lista `diligencias` traz por padrão as 10 de prazo mais próximo (use `limite`); `total_abertas` é sempre o total do conjunto.",
  { municipio_id: municipioId, limite: z.number().int().min(1).max(100).optional().describe("Quantas diligências trazer na lista (prazo mais próximo primeiro). Padrão 10, máx 100. Não afeta `total_abertas`.") },
  async ({ municipio_id, limite }) => jsonTxt(await apiGet("/diligencias", { municipio_id, limite })),
);

// ========================================
// Start
// ========================================
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("verus-mcp-geral v3.4.0 rodando via STDIO (HTTP → Verus /ia-dados)...");

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
