// Imports
// ========================================================
import { config } from "dotenv";
import express from "express";
import cors from "cors";
import multer from "multer";
import multerS3 from "multer-s3";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

// ENV VARS
// ========================================================
config();
const NODE_ENV: string = process.env.NODE_ENV || "development";
const FILE_DEST: string = process.env.FILE_DEST || "bucket";
const FILE_SERVER_URL: string =
  process.env.FILE_SERVER_URL || "http://localhost:5002";
const FILEBASE_BUCKET = process.env.FILEBASE_BUCKET || "";
// Configured AWS S3 Client For Filebase
const s3 = new S3Client({
  endpoint: "https://s3.filebase.com",
  region: process.env.FILEBASE_REGION || "",
  credentials: {
    accessKeyId: process.env.FILEBASE_ACCESS_KEY || "",
    secretAccessKey: process.env.FILEBASE_SECRET_KEY || "",
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
//app.use(cors());
app.use(
  cors({
    origin: "*",
  })
);

/**
 * Main uploaderaaa middleware that configures the final `destination` of the file and how the `filename` would be set once saved
 */
const upload =
  // If production use the s3 client ok
  NODE_ENV === "production"
    ? multer({
        storage: multerS3({
          s3: s3,
          bucket: FILEBASE_BUCKET,
          metadata: (_req, file, cb) => {
            cb(null, { fieldName: file.originalname });
          },
          key: (_req, file, cb) => {
            cb(null, file.originalname);
          },
        }),
      })
    : multer({
        storage: multerS3({
          s3: s3,
          bucket: FILEBASE_BUCKET,
          metadata: (_req, file, cb) => {
            cb(null, { fieldName: file.originalname });
          },
          key: (_req, file, cb) => {
            cb(null, file.originalname);
          },
        }),
      });
//multer({
// storage: multer.diskStorage({
//   destination: (_req, file, callback) => {
//     callback(null, FILE_DEST);
//   },
//  filename: (_req, file, callback) => {
//    callback(null, file.originalname);
//   },
//  }),
// });

// Endpoints / Routes
// ========================================================
/**
 * Main endpoint to verify that things are working and what environment mode it's running in
 */
app.get("/", (_req, res) => res.send({ environment: NODE_ENV }));

/**
 * Upload endpoint that accepts an input file field of `file`
 */
app.post("/upload", upload.single("file"), async (req, res) => {
  const apiKey = req.header("x-api-key");
  const responseData = {
    file: req.file?.originalname,
    url: `${FILE_SERVER_URL}/${req.file?.originalname}`,
  };

  const APIKEY = process.env.KEY1;

  if (APIKEY != apiKey){
    return res.status(401).json({
      msg: "Auth Failed, please request your key at contato@ipfs.com.br",
    });
  }  else{
  // If production retrieve file data to get the ipfs CID
  //if (NODE_ENV === "production") {
  responseData.url = "";
  console.log(responseData.url);
  console.log("antes");

  while (responseData.url == "") {
    console.log("dentro");
    const commandGetObject = new GetObjectCommand({
      Bucket: FILEBASE_BUCKET,
      Key: req.file?.originalname,
    });
    const response = await s3.send(commandGetObject);
    responseData.url = `${response.Metadata?.cid}`;
    //}]
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (responseData.url != "") {
      return res.json({ data: responseData });
    }
  }
  }
});

// Exports
// ========================================================
export default app;
