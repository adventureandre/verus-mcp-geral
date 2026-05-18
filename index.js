import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const server = new McpServer({
  name: "verus-mcp-geral",
  version: "2.1.0",
});

const DATABASE_URL = process.env.DATABASE_URL;
const DEFAULT_SCHEMA = process.env.VERUS_DEFAULT_SCHEMA || "public";
const MAX_ROWS = Number(process.env.VERUS_MAX_ROWS || 100);
const HARD_MAX_ROWS = 500;
const STATEMENT_TIMEOUT_MS = Number(process.env.VERUS_STATEMENT_TIMEOUT_MS || 15000);

if (!DATABASE_URL) {
  console.error("[verus-mcp-geral] DATABASE_URL não definida");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

function jsonTxt(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function safeIdent(name) {
  return String(name).replace(/[^a-zA-Z0-9_]/g, "");
}

function qualified(schema, table) {
  return `"${safeIdent(schema)}"."${safeIdent(table)}"`;
}

const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|MERGE|REPLACE|REINDEX|VACUUM|CLUSTER|LOCK|COMMENT|SECURITY|CALL|DO|LISTEN|NOTIFY|UNLISTEN|SET|RESET|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|REFRESH)\b/i;

function isReadOnlySql(sql) {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith("SELECT") && !upper.startsWith("WITH") && !upper.startsWith("SHOW") && !upper.startsWith("EXPLAIN")) {
    return { ok: false, reason: "Apenas SELECT/WITH/SHOW/EXPLAIN são permitidos" };
  }
  if (WRITE_KEYWORDS.test(trimmed)) {
    return { ok: false, reason: "Comando contém keyword de escrita bloqueada" };
  }
  if (/;\s*\S/.test(trimmed)) {
    return { ok: false, reason: "Múltiplas statements não são permitidas" };
  }
  return { ok: true, sql: trimmed };
}

/**
 * Executa qualquer query em transação READ ONLY — qualquer tentativa de
 * escrita é abortada pelo próprio Postgres, mesmo que escape da validação.
 */
async function readOnlyQuery(sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const result = await client.query(sql, params);
    await client.query("ROLLBACK");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

function ensureLimit(sql, limit) {
  return /LIMIT\s+\d+/i.test(sql) ? sql : `${sql} LIMIT ${limit}`;
}

// ========================================
// Tool: listSchemas
// ========================================
server.tool(
  "listSchemas",
  "Lista todos os schemas do banco (exclui schemas internos do Postgres).",
  {},
  async () => {
    try {
      const { rows } = await readOnlyQuery(
        `SELECT schema_name
         FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
           AND schema_name NOT LIKE 'pg_%'
         ORDER BY schema_name`
      );
      return jsonTxt({ success: true, total: rows.length, schemas: rows.map(r => r.schema_name) });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: listTables
// ========================================
server.tool(
  "listTables",
  "Lista as tabelas e views de um schema (default: public). Útil pra IA descobrir o que existe no banco antes de consultar.",
  {
    schema: z.string().optional().default(DEFAULT_SCHEMA)
      .describe("Schema a inspecionar (default: public)"),
  },
  async ({ schema }) => {
    try {
      const safe = safeIdent(schema);
      const { rows } = await readOnlyQuery(
        `SELECT table_name, table_type
         FROM information_schema.tables
         WHERE table_schema = $1
         ORDER BY table_name`,
        [safe]
      );
      return jsonTxt({ success: true, schema: safe, total: rows.length, tables: rows });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: describeTable
// ========================================
server.tool(
  "describeTable",
  "Descreve colunas + constraints (PK, FKs com referência, uniques) e índices de uma tabela. Use sempre antes de montar consultas em tabelas desconhecidas.",
  {
    table: z.string().describe("Nome da tabela"),
    schema: z.string().optional().default(DEFAULT_SCHEMA),
  },
  async ({ table, schema }) => {
    try {
      const safeT = safeIdent(table);
      const safeS = safeIdent(schema);

      const { rows: columns } = await readOnlyQuery(
        `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [safeS, safeT]
      );
      if (columns.length === 0) {
        return jsonTxt({ success: false, error: `Tabela '${safeS}.${safeT}' não encontrada` });
      }

      const { rows: primaryKey } = await readOnlyQuery(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = $1 AND tc.table_name = $2
         ORDER BY kcu.ordinal_position`,
        [safeS, safeT]
      );

      const { rows: foreignKeys } = await readOnlyQuery(
        `SELECT
           tc.constraint_name,
           kcu.column_name,
           ccu.table_schema AS references_schema,
           ccu.table_name   AS references_table,
           ccu.column_name  AS references_column,
           rc.update_rule,
           rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = tc.constraint_name
          AND rc.constraint_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = $1 AND tc.table_name = $2
         ORDER BY tc.constraint_name, kcu.ordinal_position`,
        [safeS, safeT]
      );

      const { rows: uniques } = await readOnlyQuery(
        `SELECT tc.constraint_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'UNIQUE'
           AND tc.table_schema = $1 AND tc.table_name = $2
         ORDER BY tc.constraint_name, kcu.ordinal_position`,
        [safeS, safeT]
      );

      const { rows: indexes } = await readOnlyQuery(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2
         ORDER BY indexname`,
        [safeS, safeT]
      );

      return jsonTxt({
        success: true,
        schema: safeS,
        table: safeT,
        columns,
        primary_key: primaryKey.map(r => r.column_name),
        foreign_keys: foreignKeys,
        uniques,
        indexes,
      });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: findReferences
// ========================================
server.tool(
  "findReferences",
  "Lista todas as FKs de entrada — quais tabelas/colunas referenciam essa tabela. Útil pra entender o que depende dela antes de explorar relações.",
  {
    table: z.string(),
    schema: z.string().optional().default(DEFAULT_SCHEMA),
  },
  async ({ table, schema }) => {
    try {
      const safeT = safeIdent(table);
      const safeS = safeIdent(schema);
      const { rows } = await readOnlyQuery(
        `SELECT
           tc.table_schema  AS from_schema,
           tc.table_name    AS from_table,
           kcu.column_name  AS from_column,
           ccu.column_name  AS references_column,
           tc.constraint_name,
           rc.update_rule,
           rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = tc.constraint_name
          AND rc.constraint_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND ccu.table_schema = $1 AND ccu.table_name = $2
         ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position`,
        [safeS, safeT]
      );
      return jsonTxt({ success: true, target: `${safeS}.${safeT}`, total: rows.length, referenced_by: rows });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: countRows
// ========================================
server.tool(
  "countRows",
  "Conta registros de uma tabela. Útil pra IA dimensionar antes de listar.",
  {
    table: z.string(),
    schema: z.string().optional().default(DEFAULT_SCHEMA),
  },
  async ({ table, schema }) => {
    try {
      const { rows } = await readOnlyQuery(
        `SELECT COUNT(*)::bigint AS total FROM ${qualified(schema, table)}`
      );
      return jsonTxt({ success: true, table: `${safeIdent(schema)}.${safeIdent(table)}`, total: Number(rows[0].total) });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: listRecords
// ========================================
server.tool(
  "listRecords",
  "Lista registros paginados de uma tabela. Aceita filtro `where` (igualdade simples por coluna). Sempre use describeTable antes pra conhecer colunas reais.",
  {
    table: z.string(),
    schema: z.string().optional().default(DEFAULT_SCHEMA),
    page: z.number().int().positive().optional().default(1),
    limit: z.number().int().positive().max(HARD_MAX_ROWS).optional().default(MAX_ROWS),
    orderBy: z.string().optional().describe("Coluna pra ORDER BY (opcional)"),
    direction: z.enum(["ASC", "DESC"]).optional().default("ASC"),
    where: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe('Filtros de igualdade: { "coluna": valor, ... }. Valor null vira IS NULL.'),
  },
  async ({ table, schema, page, limit, orderBy, direction, where }) => {
    try {
      const offset = (page - 1) * limit;
      const order = orderBy ? `ORDER BY "${safeIdent(orderBy)}" ${direction}` : "ORDER BY 1";

      const whereClauses = [];
      const params = [];
      if (where && typeof where === "object") {
        for (const [col, val] of Object.entries(where)) {
          const safeCol = safeIdent(col);
          if (!safeCol) continue;
          if (val === null) {
            whereClauses.push(`"${safeCol}" IS NULL`);
          } else {
            params.push(val);
            whereClauses.push(`"${safeCol}" = $${params.length}`);
          }
        }
      }
      const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

      params.push(limit, offset);
      const sql = `SELECT * FROM ${qualified(schema, table)} ${whereSql} ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const { rows } = await readOnlyQuery(sql, params);
      return jsonTxt({ success: true, page, limit, total: rows.length, filters: where || {}, records: rows });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: getRecord
// ========================================
server.tool(
  "getRecord",
  "Busca um registro por valor de uma coluna (default: id). Retorna o primeiro match.",
  {
    table: z.string(),
    value: z.union([z.string(), z.number()]).describe("Valor procurado"),
    column: z.string().optional().default("id").describe("Coluna usada na comparação (default: id)"),
    schema: z.string().optional().default(DEFAULT_SCHEMA),
  },
  async ({ table, value, column, schema }) => {
    try {
      const sql = `SELECT * FROM ${qualified(schema, table)} WHERE "${safeIdent(column)}" = $1 LIMIT 1`;
      const { rows } = await readOnlyQuery(sql, [value]);
      if (rows.length === 0) {
        return jsonTxt({ success: false, error: `Registro com ${column}='${value}' não encontrado em ${schema}.${table}` });
      }
      return jsonTxt({ success: true, record: rows[0] });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: searchTable
// ========================================
server.tool(
  "searchTable",
  "Busca registros aplicando ILIKE em uma coluna de texto. Útil pra encontrar dados por palavra-chave.",
  {
    table: z.string(),
    column: z.string().describe("Coluna de texto onde aplicar o ILIKE"),
    text: z.string().min(1).describe("Trecho de texto a procurar"),
    schema: z.string().optional().default(DEFAULT_SCHEMA),
    limit: z.number().int().positive().max(HARD_MAX_ROWS).optional().default(MAX_ROWS),
  },
  async ({ table, column, text, schema, limit }) => {
    try {
      const sql = `SELECT * FROM ${qualified(schema, table)} WHERE "${safeIdent(column)}"::text ILIKE $1 ORDER BY 1 LIMIT $2`;
      const { rows } = await readOnlyQuery(sql, [`%${text}%`, limit]);
      return jsonTxt({ success: true, total: rows.length, records: rows });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: distinctValues
// ========================================
server.tool(
  "distinctValues",
  "Lista valores únicos de uma coluna com contagem. Crítico pra descobrir valores possíveis antes de filtrar (status, tipo, categoria). Use antes de listRecords com where.",
  {
    table: z.string(),
    column: z.string(),
    schema: z.string().optional().default(DEFAULT_SCHEMA),
    limit: z.number().int().positive().max(HARD_MAX_ROWS).optional().default(MAX_ROWS),
  },
  async ({ table, column, schema, limit }) => {
    try {
      const safeCol = safeIdent(column);
      const sql = `SELECT "${safeCol}" AS value, COUNT(*)::bigint AS count
                   FROM ${qualified(schema, table)}
                   GROUP BY "${safeCol}"
                   ORDER BY count DESC, value
                   LIMIT $1`;
      const { rows } = await readOnlyQuery(sql, [limit]);
      return jsonTxt({
        success: true,
        column: safeCol,
        total: rows.length,
        values: rows.map(r => ({ value: r.value, count: Number(r.count) })),
      });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: sampleTable
// ========================================
server.tool(
  "sampleTable",
  "Retorna N linhas amostradas pra inspecionar o formato real dos dados (datas, máscaras de CPF/CNPJ, enums, etc) antes de montar consultas.",
  {
    table: z.string(),
    schema: z.string().optional().default(DEFAULT_SCHEMA),
    n: z.number().int().positive().max(50).optional().default(5),
  },
  async ({ table, schema, n }) => {
    try {
      const sql = `SELECT * FROM ${qualified(schema, table)} ORDER BY random() LIMIT $1`;
      const { rows } = await readOnlyQuery(sql, [n]);
      return jsonTxt({ success: true, table: `${safeIdent(schema)}.${safeIdent(table)}`, total: rows.length, sample: rows });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: listEnums
// ========================================
server.tool(
  "listEnums",
  "Lista tipos enum customizados do Postgres e seus valores. Use quando describeTable mostrar uma coluna com data_type='USER-DEFINED' pra descobrir valores válidos.",
  {
    schema: z.string().optional().default(DEFAULT_SCHEMA),
  },
  async ({ schema }) => {
    try {
      const sql = `
        SELECT n.nspname AS schema, t.typname AS enum_name,
               array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = $1
        GROUP BY n.nspname, t.typname
        ORDER BY t.typname`;
      const { rows } = await readOnlyQuery(sql, [safeIdent(schema)]);
      return jsonTxt({ success: true, schema: safeIdent(schema), total: rows.length, enums: rows });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: runSelect
// ========================================
server.tool(
  "runSelect",
  "Executa SELECT/WITH/SHOW/EXPLAIN arbitrário em modo READ ONLY. Bloqueia qualquer comando de escrita. Resultado limitado.",
  {
    sql: z.string().describe("Query SQL — DEVE iniciar com SELECT, WITH, SHOW ou EXPLAIN"),
    limit: z.number().int().positive().max(HARD_MAX_ROWS).optional().default(MAX_ROWS),
  },
  async ({ sql, limit }) => {
    const check = isReadOnlySql(sql);
    if (!check.ok) {
      return jsonTxt({ success: false, error: check.reason });
    }
    try {
      const limited = ensureLimit(check.sql, limit);
      const { rows, fields } = await readOnlyQuery(limited);
      return jsonTxt({
        success: true,
        total: rows.length,
        columns: fields?.map(f => f.name) ?? [],
        data: rows,
      });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Start
// ========================================
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("verus-mcp-geral v2.1.0 rodando via STDIO (READ ONLY)...");

const shutdown = async () => {
  try { await pool.end(); } catch {}
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
