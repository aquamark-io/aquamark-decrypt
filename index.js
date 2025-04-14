const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const fs = require("fs");
const { exec } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(fileUpload());

app.post("/decrypt", async (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(400).send("No file uploaded.");
  }

  const uploadedFile = req.files.file;
  const inputPath = `/tmp/${Date.now()}-${uploadedFile.name}`;
  const outputPath = inputPath.replace(/\.pdf$/, "-decrypted.pdf");

  // Move file to temp directory
  await uploadedFile.mv(inputPath);

  // Run qpdf to decrypt
  exec(`qpdf --decrypt "${inputPath}" "${outputPath}"`, (error) => {
    fs.unlinkSync(inputPath); // Clean up original file

    if (error || !fs.existsSync(outputPath)) {
      return res.status(500).send("Failed to decrypt PDF.");
    }

    const fileStream = fs.createReadStream(outputPath);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="decrypted.pdf"');
    fileStream.pipe(res);
    fileStream.on("close", () => fs.unlinkSync(outputPath)); // Clean up decrypted file
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
