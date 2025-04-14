const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(fileUpload());

// Decrypt endpoint
app.post("/decrypt", async (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(400).send("No file uploaded.");
  }

  const uploadedFile = req.files.file;
  const tempId = Date.now();
  const inputPath = path.join(__dirname, `temp-${tempId}.pdf`);
  const outputPath = path.join(__dirname, `temp-${tempId}-decrypted.pdf`);

  // Save file to disk
  try {
    await uploadedFile.mv(inputPath);
  } catch (moveErr) {
    console.error("❌ Failed to save uploaded file:", moveErr);
    return res.status(500).send("Could not save uploaded PDF.");
  }

  // Run qpdf decryption
  exec(`qpdf --decrypt "${inputPath}" "${outputPath}"`, (error, stdout, stderr) => {
    if (error) {
      console.error("❌ QPDF Error:", error.message);
      console.error("📄 STDERR:", stderr);
      fs.unlinkSync(inputPath);
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
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    }
  });
});

// Health check route
app.get("/", (req, res) => {
  res.send("Aquamark Decryption Service is running.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
