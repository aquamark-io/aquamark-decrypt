const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb, degrees } = require("pdf-lib");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");
const sharp = require("sharp");
const { createCanvas } = require("canvas");

const app = express();
const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(fileUpload());

/* -----------------------------
   🔓 Decrypt Endpoint
----------------------------- */
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

  exec(`qpdf --decrypt "${inputPath}" "${outputPath}"`, (error) => {
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

/* -----------------------------
   💧 Watermark Endpoint
----------------------------- */
app.post("/watermark", async (req, res) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send("Missing or invalid authorization token.");
  }

  const token = authHeader.split(" ")[1];
  if (token !== process.env.AQUAMARK_API_KEY) {
    return res.status(401).send("Invalid API key.");
  }

  if (!req.files || !req.files.file || !req.body.user_email) {
  return res.status(400).send('Missing file or user_email');
}
const lender = req.body.lender || null;


  const userEmail = req.body.user_email;
  const file = req.files.file;

  try {
    // 🗄️ Load PDF (or decrypt if encrypted)
    let pdfBytes = file.data;
    try {
      await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
    } catch {
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

    // 🔍 Check Usage Data
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

    // 🎯 Get Logo
    const { data: logoList } = await supabase.storage.from("logos").list(userEmail);
    if (!logoList || logoList.length === 0) throw new Error("No logo found");

    const latestLogo = logoList.sort((a, b) =>
      parseInt(b.name.split("-")[1]) - parseInt(a.name.split("-")[1])
    )[0];
    const logoPath = `${userEmail}/${latestLogo.name}`;
    const { data: logoUrlData } = supabase.storage.from("logos").getPublicUrl(logoPath);
    const logoRes = await fetch(logoUrlData.publicUrl);
    const logoBytes = await logoRes.arrayBuffer();
     
    // 📌 **Create Watermark Layer**
    const watermarkDoc = await PDFDocument.create();
    const watermarkImage = await watermarkDoc.embedPng(logoBytes);

    const { width, height } = pdfDoc.getPages()[0].getSize();
    const watermarkPage = watermarkDoc.addPage([width, height]);

    const logoWidth = width * 0.2;
    const logoHeight = (logoWidth / watermarkImage.width) * watermarkImage.height;

    for (let x = 0; x < width; x += (logoWidth + 150)) {
      for (let y = 0; y < height; y += (logoHeight + 150)) {
        watermarkPage.drawImage(watermarkImage, {
          x,
          y,
          width: logoWidth,
          height: logoHeight,
          opacity: 0.15,
          rotate: degrees(45)
        });
      }
    }
     
    const watermarkPdfBytes = await watermarkDoc.save();
    const watermarkEmbed = await PDFDocument.load(watermarkPdfBytes);
    const [embeddedPage] = await pdfDoc.embedPages([watermarkEmbed.getPages()[0]]);

// 📌 Overlay the watermark logo (XObject) on each page
pdfDoc.getPages().forEach(page => {
  page.drawPage(embeddedPage, { x: 0, y: 0, width, height });
});

// 🛡️ Overlay circular lender badge if lender is present
if (lender) {
  // Step 1: Create PNG of lender name centered
  const canvas = createCanvas(500, 500);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(0, 0, 0, 0.15)";
  ctx.font = "bold 32px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(lender, 250, 250);

  const nameBuffer = canvas.toBuffer("image/png");

  // Step 2: Composite with badge
  const finalBadge = await sharp(path.join(__dirname, "warning.png"))
    .composite([{ input: nameBuffer, top: 0, left: 0 }])
    .png()
    .toBuffer();

  // Step 3: Embed badge into PDF
  const badgeImage = await pdfDoc.embedPng(finalBadge);
  const dims = badgeImage.scale(0.5);
  const centerX = (width - dims.width) / 2;
  const centerY = (height - dims.height) / 2;

  pdfDoc.getPages().forEach(page => {
    page.drawImage(badgeImage, {
      x: centerX,
      y: centerY,
      width: dims.width,
      height: dims.height,
    });
  });
}     

    const finalPdf = await pdfDoc.save();

    // 📊 Update Usage Tracking
const newPagesUsed = usage.pages_used + numPages;
const newPagesRemaining = usage.page_credits - newPagesUsed;

console.log(`Updating usage for ${userEmail}:`);
console.log(`Pages Used: ${newPagesUsed}`);
console.log(`Pages Remaining: ${newPagesRemaining}`);

const { data, error } = await supabase.from("usage")
  .update({ 
    pages_used: newPagesUsed,
    pages_remaining: newPagesRemaining
  })
  .eq("user_email", userEmail)
  .select(); // Add .select() to force the update to return data

if (error) {
  console.error("❌ Error updating usage data:", error.message);
} else {
  console.log("✅ Usage data updated successfully:", data);
}
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${file.name.replace('.pdf', '')}-protected.pdf"`);
    res.send(Buffer.from(finalPdf));
  } catch (err) {
    console.error("❌ Watermark error:", err);
    res.status(500).send("Failed to process watermark: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
