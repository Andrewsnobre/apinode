// src/app.ts
// ========================================================
// Imports
import { config } from "dotenv";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import multerS3 from "multer-s3";
import {
  S3Client,
  HeadObjectCommand,
  HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";


// ENV
// ========================================================
config();

const NODE_ENV = process.env.NODE_ENV || "development";
const FILE_SERVER_URL = process.env.FILE_SERVER_URL || "http://localhost:5002";
const FILEBASE_BUCKET = process.env.FILEBASE_BUCKET || "";
const FILEBASE_REGION = process.env.FILEBASE_REGION || "";
const FILEBASE_ACCESS_KEY = process.env.FILEBASE_ACCESS_KEY || "";
const FILEBASE_SECRET_KEY = process.env.FILEBASE_SECRET_KEY || "";
const API_KEY = process.env.KEY1 || "";
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || "100");

// S3 (Filebase)
const s3 = new S3Client({
  endpoint: "https://s3.filebase.com",
  region: FILEBASE_REGION,
  credentials: {
    accessKeyId: FILEBASE_ACCESS_KEY,
    secretAccessKey: FILEBASE_SECRET_KEY,
  },
});

// App
// ========================================================
const app = express();


app.use(
  cors({
    origin: "*", // ajuste se precisar
  })
);
app.use(express.json());

// Middlewares
// ========================================================
// 1) Auth por x-api-key ANTES do upload
function apiKeyGuard(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.header("x-api-key");
  if (!API_KEY || apiKey !== API_KEY) {
    return res.status(401).json({
      msg: "Auth Failed, solicite sua chave em contato@ipfs.com.br",
    });
  }
  return next();
}

// 2) Multer S3 (uma única configuração)
const upload = multer({
  storage: multerS3({
    s3,
    bucket: FILEBASE_BUCKET,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (_req, file, cb) => {
      cb(null, { originalname: file.originalname });
    },
    key: (_req, file, cb) => {
      // evita colisão e mantém nome visível
      const key = `${Date.now()}-${randomUUID()}-${file.originalname}`;
      cb(null, key);
    },
  }),
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, // MB
  },
  fileFilter: (_req, file, cb) => {
    // ajuste se quiser restringir tipos
    if (!file.originalname) return cb(new Error("Arquivo inválido"));
    cb(null, true);
  },
});

// Utils
// ========================================================
/**
 * Espera o metadado `cid` aparecer via HeadObject em backoff exponencial,
 * até `maxWaitMs` (padrão 30s). Retorna `cid` ou `null` se não aparecer a tempo.
 */
async function waitForCid(
  bucket: string,
  key: string,
  opts?: { maxWaitMs?: number; maxAttempts?: number }
): Promise<string | null> {
  const maxWaitMs = opts?.maxWaitMs ?? 30_000;
  const maxAttempts = opts?.maxAttempts ?? 6; // ~ (0.5s, 1s, 2s, 4s, 8s, 16s) ~= 31.5s
  let attempt = 0;
  let delay = 500;

  const started = Date.now();

  while (attempt < maxAttempts && Date.now() - started < maxWaitMs) {
    try {
      const head = (await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key })
      )) as HeadObjectCommandOutput;

      const cid = head.Metadata?.cid || head.Metadata?.CID || head.Metadata?.Cid;
      if (cid && cid.trim().length > 0) {
        return cid.trim();
      }
    } catch (err) {
      // se 404 ou erro transitório, apenas tenta novamente
    }

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 4000);
    attempt++;
  }

  return null;
}

// Rotas
// ========================================================
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, environment: NODE_ENV });
});

app.get("/", (_req, res) => res.send({ environment: NODE_ENV }));

/**
 * Upload endpoint
 * - valida API Key antes
 * - faz upload para Filebase
 * - tenta pegar o CID com backoff (sem travar)
 * - se não achar a tempo, retorna 202 com dados para o cliente checar depois
 */
app.post("/upload", apiKeyGuard, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ msg: "Nenhum arquivo enviado (field: file)." });
    }

    // @ts-ignore - multer-s3 adiciona `key` em req.file
    const key: string = req.file.key || req.file.originalname;
    const originalname = req.file.originalname;

    // tenta obter o CID (sem while infinito)
    const cid = await waitForCid(FILEBASE_BUCKET, key);

    // monta payload base
    const base = {
      file: originalname,
      key,
      // URL "local" antiga que você tinha:
      file_server_url: `${FILE_SERVER_URL}/${originalname}`,
    };

    if (cid) {
      return res.status(200).json({
        data: {
          ...base,
          cid,
          // links úteis (ajuste se preferir)
          ipfs_uri: `ipfs://${cid}`,
          gateway_url: `https://ipfs.filebase.io/ipfs/${cid}`,
        },
      });
    }

    // ainda não propagou — não trava o servidor
    return res.status(202).json({
      msg: "Arquivo recebido. CID ainda não disponível. Tente novamente em instantes.",
      data: { ...base },
    });
  } catch (err: any) {
    return res.status(500).json({
      msg: "Falha no upload",
      error: err?.message || "unknown_error",
    });
  }
});

// Global error handler (fallback)
app.use(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (err: any, _req: Request, res: Response, _next: NextFunction) => {
    return res.status(500).json({
      msg: "Erro inesperado",
      error: err?.message || "unknown_error",
    });
  }
);

export default app;
