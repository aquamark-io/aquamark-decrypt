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

    let totalPagesUsed = 0;
    let existingUsage = null;

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
          const numPages = pdfDoc.getPageCount();

          // 🔒 Usage check + accumulate
          if (totalPagesUsed === 0) {
            existingUsage = await supabase
              .from("usage")
              .select("*")
              .eq("user_email", user_email)
              .single();
            if (!existingUsage.data) throw new Error("Usage record not found");
          }

          if (
            existingUsage.data.page_credits -
              existingUsage.data.pages_used -
              totalPagesUsed <
            numPages
          ) {
            throw new Error("Insufficient credits");
          }

          totalPagesUsed += numPages;

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

    // ✅ One-time usage update
    if (existingUsage?.data && totalPagesUsed > 0) {
      await supabase
        .from("usage")
        .update({
          pages_used: existingUsage.data.pages_used + totalPagesUsed,
          pages_remaining:
            existingUsage.data.page_credits -
            existingUsage.data.pages_used -
            totalPagesUsed,
        })
        .eq("user_email", existingUsage.data.user_email);
    }

    res.json(results.filter((f) => f && !f.error));
  } catch (err) {
    console.error("❌ Batch route error:", err);
    res.status(500).send("Batch processing failed: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
