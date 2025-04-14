const express = require('express');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(fileUpload());

// Endpoint to handle PDF decryption
app.post("/decrypt", (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(400).send("No file uploaded.");
  }

  const uploadedFile = req.files.file;
  const inputPath = `uploads/${Date.now()}-${uploadedFile.name}`;
  const outputPath = `${inputPath}-decrypted.pdf`;

  // Save uploaded file
  uploadedFile.mv(inputPath, (err) => {
    if (err) {
      console.error("❌ File Save Error:", err);
      return res.status(500).send("Failed to save uploaded file.");
    }

    // Run qpdf to decrypt
    exec(`qpdf --decrypt "${inputPath}" "${outputPath}"`, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ QPDF Error:", error.message);
        console.error("📄 STDERR:", stderr);
        return res.status(500).send("Failed to decrypt PDF.");
      }

      console.log("✅ QPDF Decryption succeeded.");

      try {
        const decryptedBuffer = fs.readFileSync(outputPath);
        res.setHeader("Content-Type", "application/pdf");
        res.send(decryptedBuffer);
      } catch (readErr) {
        console.error("❌ Failed to read decrypted file:", readErr.message);
        res.status(500).send("Failed to read decrypted PDF.");
      } finally {
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
      }
    });
  });
});

// Health check route
app.get("/", (req, res) => {
  res.send("Aquamark Decryption Service is running.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

