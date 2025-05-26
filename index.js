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
  const file = req.files.file;

  try {
    // 🗄️ Decrypt if needed
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

    // 📊 Check usage
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

    // 🖼️ Get logo from Supabase
    const { data: logoList } = await supabase.storage.from("logos").list(userEmail);
    if (!logoList || logoList.length === 0) throw new Error("No logo found");

    const latestLogo = logoList.sort((a, b) =>
      parseInt(b.name.split("-")[1]) - parseInt(a.name.split("-")[1])
    )[0];
    const logoPath = `${userEmail}/${latestLogo.name}`;
    const { data: logoUrlData } = supabase.storage.from("logos").getPublicUrl(logoPath);
    const logoRes = await fetch(logoUrlData.publicUrl);
    const logoBytes = await logoRes.arrayBuffer();

    // 🔁 Create combined watermark page (logo + QR)
    const watermarkDoc = await PDFDocument.create();
    const watermarkImage = await watermarkDoc.embedPng(logoBytes);
    const { width, height } = pdfDoc.getPages()[0].getSize();
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

    // 🧷 Add QR to watermark layer
    const qrSize = 20;
    watermarkPage.drawImage(qrImage, {
      x: width - qrSize - 15,
      y: 15,
      width: qrSize,
      height: qrSize,
      opacity: 0.4,
    });

    // ✅ Save watermark and apply to all pages
    const watermarkPdfBytes = await watermarkDoc.save();
    const watermarkEmbed = await PDFDocument.load(watermarkPdfBytes);
    const [embeddedPage] = await pdfDoc.embedPages([watermarkEmbed.getPages()[0]]);
    pdfDoc.getPages().forEach((page) => {
      page.drawPage(embeddedPage, { x: 0, y: 0, width, height });
    });

    // 📈 Track usage
    const newPagesUsed = usage.pages_used + numPages;
    const newPagesRemaining = usage.page_credits - newPagesUsed;
    await supabase
      .from("usage")
      .update({
        pages_used: newPagesUsed,
        pages_remaining: newPagesRemaining,
      })
      .eq("user_email", userEmail)
      .select();

    const finalPdf = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.name.replace(".pdf", "")}-protected.pdf"`
    );
    res.send(Buffer.from(finalPdf));
  } catch (err) {
    console.error("❌ Watermark error:", err);
    res.status(500).send("Failed to process watermark: " + err.message);
  }
});

// ✅ NEW: Parallel batch processing
app.post("/batch-watermark", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).send("Missing or invalid authorization token.");
    }

    const token = authHeader.split(" ")[1];
    if (token !== process.env.AQUAMARK_API_KEY) {
      return res.status(401).send("Invalid API key.");
    }

    const files = req.body;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).send("Invalid or empty payload");
    }

    const results = await Promise.all(
      files.map(async ({ user_email, file, lender }, i) => {
        try {
          let pdfBytes = Buffer.from(file, "base64");
          try {
            await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
          } catch {
            const inPath = path.join(__dirname, `temp-${i}.pdf`);
            const outPath = path.join(__dirname, `temp-${i}-dec.pdf`);
            fs.writeFileSync(inPath, pdfBytes);
            await new Promise((resolve, reject) => {
              exec(`qpdf --decrypt "${inPath}" "${outPath}"`, (err) =>
                err ? reject(err) : resolve()
              );
            });
            pdfBytes = fs.readFileSync(outPath);
            fs.unlinkSync(inPath);
            fs.unlinkSync(outPath);
          }

          const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

          const { data: usage } = await supabase
            .from("usage")
            .select("*")
            .eq("user_email", user_email)
            .single();

          const numPages = pdfDoc.getPageCount();
          if (usage.page_credits - usage.pages_used < numPages) {
            throw new Error("Insufficient credits");
          }

          const { data: logoList } = await supabase.storage.from("logos").list(user_email);
          const latestLogo = logoList.sort((a, b) =>
            parseInt(b.name.split("-")[1]) - parseInt(a.name.split("-")[1])
          )[0];
          const logoUrl = supabase.storage
            .from("logos")
            .getPublicUrl(`${user_email}/${latestLogo.name}`).data.publicUrl;
          const logoBytes = await (await fetch(logoUrl)).arrayBuffer();

          const watermarkDoc = await PDFDocument.create();
          const logo = await watermarkDoc.embedPng(logoBytes);
          const { width, height } = pdfDoc.getPages()[0].getSize();
          const watermarkPage = watermarkDoc.addPage([width, height]);

          const logoWidth = width * 0.2;
          const logoHeight = (logoWidth / logo.width) * logo.height;
          for (let x = 0; x < width; x += (logoWidth + 150)) {
            for (let y = 0; y < height; y += (logoHeight + 150)) {
              watermarkPage.drawImage(logo, {
                x, y, width: logoWidth, height: logoHeight,
                opacity: 0.15, rotate: degrees(45),
              });
            }
          }

          const today = new Date().toISOString().split("T")[0];
          const qrPayload = encodeURIComponent(
            `ProtectedByAquamark|${user_email}|${lender}|${today}`
          );
          const qrText = `https://aquamark.io/q.html?data=${qrPayload}`;
          const qrUrl = await QRCode.toDataURL(qrText, { margin: 0, scale: 5 });
          const qrImg = await watermarkDoc.embedPng(
            Buffer.from(qrUrl.split(",")[1], "base64")
          );

          watermarkPage.drawImage(qrImg, {
            x: width - 35, y: 15, width: 20, height: 20, opacity: 0.4,
          });

          const watermarkBytes = await watermarkDoc.save();
          const embedPage = await PDFDocument.load(watermarkBytes);
          const [overlay] = await pdfDoc.embedPages([embedPage.getPage(0)]);
          pdfDoc.getPages().forEach((p) =>
            p.drawPage(overlay, { x: 0, y: 0, width, height })
          );

          await supabase
            .from("usage")
            .update({
              pages_used: usage.pages_used + numPages,
              pages_remaining: usage.page_credits - usage.pages_used - numPages,
            })
            .eq("user_email", user_email);

          const finalPdf = await pdfDoc.save();

          return {
            filename: `Aquamark - ${lender}.pdf`,
            base64: Buffer.from(finalPdf).toString("base64"),
          };
        } catch (err) {
          console.error("❌ Error on file", i, err.message);
          return { error: err.message };
        }
      })
    );

    res.json(results.filter(f => f && !f.error));
  } catch (err) {
    console.error("❌ Batch route error:", err);
    res.status(500).send("Batch processing failed: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
