const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb, degrees } = require("pdf-lib");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");
const QRCode = require("qrcode"); // ✅ Added for QR code generation

const app = express();
const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(fileUpload());
app.use(express.json({ limit: "25mb" }));

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
    return res.status(400).send("Missing file or user_email");
  }

  const userEmail = req.body.user_email;
  const lender = req.body.lender || "N/A";
  
  // Handle both single file and multiple files
  const files = Array.isArray(req.files.file) ? req.files.file : [req.files.file];

  try {
    // 📊 Check usage first - calculate total pages needed
    let totalPages = 0;
    const processedFiles = [];

    // First pass: decrypt and count all pages
    for (const file of files) {
      let pdfBytes = file.data;
      try {
        await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
      } catch {
        const tempId = Date.now() + Math.random();
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
      const numPages = pdfDoc.getPageCount();
      totalPages += numPages;
      
      processedFiles.push({
        originalFile: file,
        pdfDoc: pdfDoc,
        pdfBytes: pdfBytes,
        numPages: numPages
      });
    }

    // Check if user has enough credits for all files
    const { data: usage, error: usageErr } = await supabase
      .from("usage")
      .select("*")
      .eq("user_email", userEmail)
      .single();
    if (usageErr || !usage) throw new Error("Usage record not found");

    if (usage.page_credits - usage.pages_used < totalPages) {
      return res.status(402).send("Not enough page credits.");
    }

    // 🖼️ Get logo from Supabase (only once)
    const { data: logoList } = await supabase.storage.from("logos").list(userEmail);
    if (!logoList || logoList.length === 0) throw new Error("No logo found");

    const latestLogo = logoList.sort((a, b) =>
      parseInt(b.name.split("-")[1]) - parseInt(a.name.split("-")[1])
    )[0];
    const logoPath = `${userEmail}/${latestLogo.name}`;
    const { data: logoUrlData } = supabase.storage.from("logos").getPublicUrl(logoPath);
    const logoRes = await fetch(logoUrlData.publicUrl);
    const logoBytes = await logoRes.arrayBuffer();

    // Process each file
    const processedPdfs = [];
    
    for (const fileData of processedFiles) {
      const { originalFile, pdfDoc, numPages } = fileData;
      const { width, height } = pdfDoc.getPages()[0].getSize();

      // 🔁 Create combined watermark page (logo + QR)
      const watermarkDoc = await PDFDocument.create();
      const watermarkImage = await watermarkDoc.embedPng(logoBytes);
      const watermarkPage = watermarkDoc.addPage([width, height]);

      // 🔢 Logo tiling
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
            rotate: degrees(45),
          });
        }
      }

      // 🔐 QR Code generation
      const today = new Date().toISOString().split("T")[0];
      const payload = encodeURIComponent(`ProtectedByAquamark|${userEmail}|${lender}|${today}`);
      const qrText = `https://aquamark.io/q.html?data=${payload}`;
      const qrDataUrl = await QRCode.toDataURL(qrText, { margin: 0, scale: 5 });
      const qrImageBytes = Buffer.from(qrDataUrl.split(",")[1], "base64");
      const qrImage = await watermarkDoc.embedPng(qrImageBytes);

      // 🧷 Add QR to same watermark page (bottom-right)
      const qrSize = 20;
      watermarkPage.drawImage(qrImage, {
        x: width - qrSize - 15,
        y: 15,
        width: qrSize,
        height: qrSize,
        opacity: 0.4,
      });

      // ✅ Save unified watermark page
      const watermarkPdfBytes = await watermarkDoc.save();
      const watermarkEmbed = await PDFDocument.load(watermarkPdfBytes);
      const [embeddedPage] = await pdfDoc.embedPages([watermarkEmbed.getPages()[0]]);

      pdfDoc.getPages().forEach((page) => {
        page.drawPage(embeddedPage, { x: 0, y: 0, width, height });
      });

      const finalPdf = await pdfDoc.save();
      processedPdfs.push({
        buffer: Buffer.from(finalPdf),
        filename: `${originalFile.name.replace(".pdf", "")}-protected.pdf`
      });
    }

    // 📈 Track usage with total pages
    const newPagesUsed = usage.pages_used + totalPages;
    const newPagesRemaining = usage.page_credits - newPagesUsed;
    await supabase
      .from("usage")
      .update({
        pages_used: newPagesUsed,
        pages_remaining: newPagesRemaining,
      })
      .eq("user_email", userEmail)
      .select();

    // Return all processed files
    if (processedPdfs.length === 1) {
      // Single file - return as before
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${processedPdfs[0].filename}"`);
      res.send(processedPdfs[0].buffer);
    } else {
      // Multiple files - return as JSON with base64 encoded files
      const response = processedPdfs.map(pdf => ({
        filename: pdf.filename,
        data: pdf.buffer.toString('base64'),
        contentType: 'application/pdf'
      }));
      
      res.setHeader("Content-Type", "application/json");
      res.json({
        files: response,
        totalFiles: processedPdfs.length,
        totalPages: totalPages
      });
    }
  } catch (err) {
    console.error("❌ Watermark error:", err);
    res.status(500).send("Failed to process watermark: " + err.message);
  }
});
