
const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb, degrees } = require("pdf-lib");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(fileUpload());

// Decrypt endpoint (original)
app.post("/decrypt", async (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(400).send("No file uploaded.");
  }

  const uploadedFile = req.files.file;
  const tempId = Date.now();
  const inputPath = path.join(__dirname, `temp-${tempId}.pdf`);
  const outputPath = path.join(__dirname, `temp-${tempId}-decrypted.pdf`);

  try {
    await uploadedFile.mv(inputPath);
  } catch (moveErr) {
    console.error("❌ Failed to save uploaded file:", moveErr);
    return res.status(500).send("Could not save uploaded PDF.");
  }

  exec(`qpdf --decrypt "${inputPath}" "${outputPath}"`, (error, stdout, stderr) => {
    if (error) {
      console.error("❌ QPDF Error:", error.message);
      fs.unlinkSync(inputPath);
      return res.status(500).send("Failed to decrypt PDF.");
    }

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

// Watermark endpoint (new)
app.post("/watermark", async (req, res) => {
  if (!req.files || !req.files.file || !req.body.user_email) {
    return res.status(400).send("Missing required fields: file and user_email.");
  }

  const userEmail = req.body.user_email;
  const file = req.files.file;

  try {
    // Try loading PDF directly
    let pdfBytes;
    try {
      pdfBytes = file.data;
      await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
    } catch {
      // Try to decrypt via qpdf
      const tempId = Date.now();
      const inPath = path.join(__dirname, `temp-${tempId}.pdf`);
      const outPath = path.join(__dirname, `temp-${tempId}-dec.pdf`);
      fs.writeFileSync(inPath, file.data);
      await new Promise((resolve, reject) => {
        exec(`qpdf --decrypt "${inPath}" "${outPath}"`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      pdfBytes = fs.readFileSync(outPath);
      fs.unlinkSync(inPath);
      fs.unlinkSync(outPath);
    }

    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

    // Get usage data
    const { data: usage, error: usageErr } = await supabase
      .from("usage")
      .select("*")
      .eq("user_email", userEmail)
      .single();
    if (usageErr || !usage) throw new Error("Usage record not found");

    const numPages = pdfDoc.getPageCount();
    if (usage.page_credits - usage.pages_used < numPages) {
      return res.status(402).send("Not enough page credits.");
    }

    // Get logo URL
    const { data: logoList } = await supabase.storage.from("logos").list(userEmail);
    if (!logoList || logoList.length === 0) throw new Error("No logo found");

    const latestLogo = logoList.sort((a, b) =>
      parseInt(b.name.split("-")[1]) - parseInt(a.name.split("-")[1])
    )[0];
    const logoPath = `${userEmail}/${latestLogo.name}`;
    const { data: logoUrlData } = supabase.storage.from("logos").getPublicUrl(logoPath);
    const logoRes = await fetch(logoUrlData.publicUrl);
    const logoBytes = await logoRes.arrayBuffer();

    // Embed logo
    let embeddedLogo;
    try {
      embeddedLogo = await pdfDoc.embedPng(logoBytes);
    } catch {
      embeddedLogo = await pdfDoc.embedJpg(logoBytes);
    }
    const logoDims = embeddedLogo.scale(0.35);

    // Optional: hologram image
    let hologramImage = null;
    try {
      const holoRes = await fetch("https://aquamark.io/hologram.png");
      if (holoRes.ok) {
        const holoBytes = await holoRes.arrayBuffer();
        hologramImage = await pdfDoc.embedPng(holoBytes);
      }
    } catch {}

    const pages = pdfDoc.getPages();
    for (const page of pages) {
      const { width, height } = page.getSize();
      for (let x = 0; x < width; x += (logoDims.width + 100)) {
        for (let y = 0; y < height; y += (logoDims.height + 100)) {
          page.drawImage(embeddedLogo, {
            x, y,
            width: logoDims.width,
            height: logoDims.height,
            opacity: 0.15,
            rotate: degrees(45)
          });
        }
      }

      if (hologramImage) {
        page.drawImage(hologramImage, {
          x: width - 55,
          y: height - 55,
          width: 45,
          height: 45,
          opacity: 0.7
        });
      }
    }

    const finalPdf = await pdfDoc.save();

    await supabase.from("usage")
      .update({ pages_used: usage.pages_used + numPages })
      .eq("user_email", userEmail);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${file.name.replace('.pdf', '')}-protected.pdf"`);
    res.send(Buffer.from(finalPdf));
  } catch (err) {
    console.error("❌ Watermark error:", err);
    res.status(500).send("Failed to process watermark: " + err.message);
  }
});

app.get("/", (req, res) => {
  res.send("Aquamark Decryption & Watermarking API is running.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
