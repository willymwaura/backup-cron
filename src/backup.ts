import { exec, execSync } from "child_process";
import { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream, unlink, statSync } from "fs";
import { filesize } from "filesize";
import path from "path";
import os from "os";

import { env } from "./env";

const uploadToS3 = async ({ name, path }: { name: string; path: string }) => {
  console.log("Uploading backup to S3...");

  const bucket = env.AWS_S3_BUCKET;

  const clientOptions: S3ClientConfig = {
    region: env.AWS_S3_REGION,
  };

  if (env.AWS_S3_ENDPOINT) {
    console.log(`Using custom endpoint: ${env.AWS_S3_ENDPOINT}`);
    clientOptions["endpoint"] = env.AWS_S3_ENDPOINT;
  }

  const client = new S3Client(clientOptions);

  await new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: name,
      Body: createReadStream(path),
    },
  }).done();

  console.log("Backup uploaded to S3...");
};

const dumpToFile = async (filePath: string) => {
  console.log("Dumping DB to file...");

  await new Promise((resolve, reject) => {
    // 'set -o pipefail' ensures errors in pg_dump aren't swallowed by gzip
    const command = `set -o pipefail; pg_dump --dbname="${env.BACKUP_DATABASE_URL}" --format=tar | gzip > "${filePath}"`;

    exec(command, { shell: "/bin/sh" }, (error, stdout, stderr) => {
      // Print stderr immediately to surface pg_dump authentication or connection errors
      if (stderr && stderr.trim().length > 0) {
        console.error("pg_dump stderr:", stderr.trimEnd());
      }

      if (error) {
        reject({ error, stderr: stderr.trimEnd() });
        return;
      }

      // Check if archive is valid and contains data
      let isValidArchive = false;
      try {
        isValidArchive = execSync(`gzip -cd "${filePath}" | head -c1`).length === 1;
      } catch (err) {
        isValidArchive = false;
      }

      if (!isValidArchive) {
        reject({
          error: "Backup archive file is invalid or empty; check the stderr output above",
          stderr: stderr.trimEnd(),
        });
        return;
      }

      console.log("Backup archive file is valid");
      console.log("Backup filesize:", filesize(statSync(filePath).size));

      resolve(undefined);
    });
  });

  console.log("DB dumped to file...");
};

const deleteFile = async (filePath: string) => {
  console.log("Deleting file...");
  await new Promise((resolve, reject) => {
    unlink(filePath, (err) => {
      if (err) {
        reject({ error: err });
      } else {
        resolve(undefined);
      }
    });
  });
};

export const backup = async () => {
  console.log("Initiating DB backup...");

  const date = new Date().toISOString();
  const timestamp = date.replace(/[:.]+/g, "-");
  const filename = `backup-${timestamp}.tar.gz`;
  const filepath = path.join(os.tmpdir(), filename);

  await dumpToFile(filepath);
  await uploadToS3({ name: filename, path: filepath });
  await deleteFile(filepath);

  console.log("DB backup complete...");
};
