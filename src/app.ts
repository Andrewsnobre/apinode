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

// ENV VARS
// ========================================================
config();

const NODE_ENV: string = process.env.NODE_ENV || "development";
const FILE_SERVER_URL: string = process.env.FILE_SERVER_URL || "http://localhost:5002";
const FILEBASE_BUCKET: string = process.env.FILEBASE_BUCKET || "";
const FILEBASE_REGION: string = process.env.FILEBASE_REGION || "";
const FILEBASE_ACCESS_KEY: string = process.env.FILEBASE_ACCESS_KEY || "";
const FILEBASE_SECRET_KEY: string = process.env.FILEBASE_SECRET_KEY || "";
const APIKEY: string = process.env.KEY1 || "";
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || "100"); // 100 MB por padrão

// Configured AWS S3 Client For Filebase
const s3 = new S3Client({
  endpoint: "https://s3.filebase.com",
  region: FILEBASE_REGION,
  credentials: {
    accessKeyId: FILEBASE_ACCESS_KEY,
    secretAccessKey: FILEBASE_SECRET_KEY,
  },
});

// Init
// ========================================================
/**
 * Initial ExpressJS
 */
const app = express();

// Middlewares
// ========================================================
/**
 * Allows for requests from other servers
 */
app.use(
  cors({
    origin: "*",
  })
);

app.use(express.json());

/**
 * Auth middleware via x-api-key (antes do upload, pra evitar custo)
 */
function apiKeyGuard(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.header("x-api-key");
  if (!APIKEY || apiKey !== APIKEY) {
    return res.status(401).json({
      msg: "Auth Failed, please request your key at contato@ipfs.com.br",
    });
  }
  return next();
}

/**
 * Uploader configurado para Filebase S3, mantendo a key como o nome original
 * Limite de 100 MB
 */
const upload = multer({
  storage: multerS3({
    s3,
    bucket: FILEBASE_BUCKET,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (_req, file, cb) => {
      cb(null, { originalname: file.originalname });
    },
    key: (_req, file, cb) => {
      // Mantém exatamente o nome original, como no seu fluxo atual
      cb(null, file.originalname);
    },
  }),
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, // 100 MB
  },
});

// Utils
// ========================================================
/**
 * Espera o metadado `cid` aparecer via HeadObject em backoff exponencial,
 * com tempo máximo (default ~45s). Retorna o cid ou null se não aparecer.
 */
async function waitCidWithBackoff(
  bucket: string,
  key: string,
  { maxWaitMs = 45_000 }: { maxWaitMs?: number } = {}
): Promise<string | null> {
  const started = Date.now();
  let delay = 500; // 0.5s, 1s, 2s, 4s, 4s...

  while (Date.now() - started < maxWaitMs) {
    try {
      const head = (await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key })
      )) as HeadObjectCommandOutput;

      const cid =
        head.Metadata?.cid || head.Metadata?.CID || head.Metadata?.Cid || "";
      if (cid && cid.trim().length > 0) {
        return cid.trim();
      }
    } catch (_err) {
      // 404/403/transient -> ignora e tenta novamente
    }

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 4000);
  }

  return null;
}

// Endpoints / Routes
// ========================================================
/**
 * Main endpoint to verify that things are working and what environment mode it's running in
 */
app.get("/", (_req, res) => res.send({ environment: NODE_ENV }));

/**
 * Healthcheck simples
 */
app.get("/healthz", (_req, res) => res.json({ ok: true, environment: NODE_ENV }));

/**
 * Upload endpoint que mantém o MESMO JSON de retorno já usado pelos apps:
 *   { data: { file, url } }
 * - `url` começa "" e vira o CID quando disponível
 * - sem while infinito; usa timeout + backoff
 * - se não achar a tempo, retorna 504 com o MESMO shape (url = "")
 */
app.post("/upload", apiKeyGuard, upload.single("file"), async (req, res) => {
  try {
    // monta exatamente como antes
    const responseData: { file?: string; url?: string } = {
      file: req.file?.originalname,
      url: `${FILE_SERVER_URL}/${req.file?.originalname}`,
    };

    // comportamento antigo: zera a url e só preenche com o CID quando existir
    responseData.url = "";

    // tenta obter o CID com timeout (sem travar servidor)
    const key = req.file?.originalname as string;
    const cid = await waitCidWithBackoff(FILEBASE_BUCKET, key, { maxWaitMs: 45_000 });

    if (cid) {
      responseData.url = cid; // MESMA semântica: url passa a ser o CID
      return res.status(200).json({ data: responseData });
    }

    // não achou a tempo -> evita loop infinito; mantém MESMO shape
    return res.status(504).json({ data: responseData });
  } catch (err: any) {
    return res.status(500).json({
      msg: "Falha no upload",
      error: err?.message || "unknown_error",
    });
  }
});

// Global error handler (fallback)
// ========================================================
app.use(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (err: any, _req: Request, res: Response, _next: NextFunction) => {
    return res.status(500).json({
      msg: "Erro inesperado",
      error: err?.message || "unknown_error",
    });
  }
);

// Exports
// ========================================================
export default app;
