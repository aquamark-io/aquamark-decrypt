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

app.post("/decrypt", async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      console.error("❌ No file uploaded.");
      return res.status(400).send("No file uploaded.");
    }

    const uploadedFile = req.files.file;
    const inputPath = path.join(__dirname, "uploads", `${Date.now()}-input.pdf`);
    const outputPath = `${inputPath}-decrypted.pdf`;

    console.log("🔍 Input path:", inputPath);
    console.log("🔍 Output path:", outputPath);

    // Save the uploaded file
    await uploadedFile.mv(inputPath);

    // Run QPDF decryption
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
        // Clean up
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
      }
    });
  } catch (e) {
    console.error("❌ Server error:", e.message);
    res.status(500).send("Unexpected server error.");
  }
});

app.get("/", (req, res) => {
  res.send("Aquamark Decryption Service is running.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
