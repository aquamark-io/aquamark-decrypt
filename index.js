const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const app = express();
const port = process.env.PORT || 3000;

// Set up multer for handling file uploads
const upload = multer({ dest: "uploads/" });

app.post("/decrypt", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).send("No file uploaded.");
  }

  const inputPath = req.file.path;
  const outputPath = `${inputPath}-decrypted.pdf`;

  exec(`qpdf --decrypt "${inputPath}" "${outputPath}"`, (error, stdout, stderr) => {
    if (error) {
      console.error("❌ QPDF Error:", error.message);
      console.error("📄 STDERR:", stderr);
      return res.status(500).send("Failed to decrypt PDF.");
    }

    console.log("✅ QPDF Decryption succeeded.");
    console.log("📤 STDOUT:", stdout);

    try {
      const decryptedBuffer = fs.readFileSync(outputPath);
      res.setHeader("Content-Type", "application/pdf");
      res.send(decryptedBuffer);
    } catch (readErr) {
      console.error("❌ Failed to read decrypted file:", readErr.message);
      res.status(500).send("Failed to read decrypted PDF.");
    } finally {
      // Clean up temp files
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    }
  });
});

app.get("/", (req, res) => {
  res.send("Aquamark Decryption Service is running.");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
