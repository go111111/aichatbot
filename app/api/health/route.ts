import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

type CheckStatus = "ok" | "degraded" | "error";

type HealthCheck = {
  status: CheckStatus;
  detail?: string;
};

const providerKeyByName: Record<string, string | undefined> = {
  deepseek: process.env.DEEPSEEK_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  mock: "mock",
};

function getUploadDir() {
  return (
    process.env.UPLOAD_DIR ||
    path.join(/*turbopackIgnore: true*/ process.cwd(), "uploads")
  );
}

function checkProvider(): HealthCheck {
  const provider = process.env.AI_PROVIDER ?? "deepseek";
  const key = providerKeyByName[provider];

  if (!key) {
    return {
      status: "error",
      detail: `${provider} provider is selected but its API key is missing`,
    };
  }

  return {
    status: "ok",
    detail: provider,
  };
}

async function checkDatabase(): Promise<HealthCheck> {
  if (!process.env.POSTGRES_URL) {
    return {
      status: process.env.NODE_ENV === "production" ? "error" : "degraded",
      detail:
        process.env.NODE_ENV === "production"
          ? "POSTGRES_URL is required in production"
          : "POSTGRES_URL is not configured; using in-memory development store",
    };
  }

  const sql = postgres(process.env.POSTGRES_URL, {
    connect_timeout: 2,
    idle_timeout: 1,
    max: 1,
  });

  try {
    await sql`select 1`;
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "database unavailable",
    };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

async function checkUploads(): Promise<HealthCheck> {
  const uploadDir = getUploadDir();

  try {
    await mkdir(uploadDir, { recursive: true });
    await access(uploadDir, constants.W_OK);
    return { status: "ok", detail: uploadDir };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "upload directory is not writable",
    };
  }
}

function getOverallStatus(checks: Record<string, HealthCheck>) {
  if (Object.values(checks).some((check) => check.status === "error")) {
    return "error";
  }

  if (Object.values(checks).some((check) => check.status === "degraded")) {
    return "degraded";
  }

  return "ok";
}

export async function GET() {
  const checks = {
    app: { status: "ok" as const },
    database: await checkDatabase(),
    provider: checkProvider(),
    uploads: await checkUploads(),
  };
  const status = getOverallStatus(checks);

  return Response.json(
    {
      status,
      checks,
      timestamp: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
      status: status === "error" ? 503 : 200,
    }
  );
}
