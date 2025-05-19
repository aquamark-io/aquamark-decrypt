const express = require("express");
const { PDFDocument, degrees } = require("pdf-lib");
const fetch = require("node-fetch");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas } = require("canvas");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const supabase = createClient(
  "https://dvzmnikrvkvgragzhrof.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2em1uaWtydmt2Z3JhZ3pocm9mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM5Njg5NzUsImV4cCI6MjA1OTU0NDk3NX0.FaHsjIRNlgf6YWbe5foz0kJFtCO4FuVFo7KVcfhKPEk"
);

function getCurrentCycleStart(startDate) {
  const start = new Date(startDate);
  const now = new Date();
  const diff = now.getTime() - start.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const periodsPassed = Math.floor(days / 30);
  start.setDate(start.getDate() + periodsPassed * 30);
  return start.toISOString();
}

async function generateLenderImage(text) {
  const width = 400;
  const height = 100;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "black";
  ctx.font = "bold 20px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, width / 2, height / 2);

  return canvas.toBuffer("image/png");
}

app.post("/watermark", async (req, res) => {
  try {
    const { pdfBase64, logoUrl, userEmail, numPages, lender } = req.body;

    if (!pdfBase64 || !logoUrl || !userEmail || !numPages) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { data: usageData, error } = await supabase
      .from("usage")
      .select("*")
      .eq("user_email", userEmail)
      .single();

    if (error || !usageData) {
      return res.status(400).json({ error: "Usage record not found" });
    }

    const currentCycleStart = getCurrentCycleStart(usageData.billing_cycle_start);
    if (new Date(usageData.billing_cycle_start).toISOString() !== currentCycleStart) {
      await supabase
        .from("usage")
        .update({ pages_used: 0 })
        .eq("user_email", userEmail);
      usageData.pages_used = 0;
    }

    if (
      usageData.plan_name !== "Enterprise" &&
      usageData.pages_used + numPages > usageData.page_credits
    ) {
      return res.status(403).json({ error: "Page credit limit exceeded" });
    }

    const existingPdfBytes = Buffer.from(pdfBase64, "base64");
    const watermarkDoc = await PDFDocument.load(existingPdfBytes);
    const pages = watermarkDoc.getPages();
    const watermarkPage = pages[0];
    const { width, height } = watermarkPage.getSize();

    const logoImageBytes = await fetch(logoUrl).then((res) => res.arrayBuffer());
    const logoImage = await watermarkDoc.embedPng(logoImageBytes);
    const logoDims = logoImage.scale(1);
    const logoWidth = logoDims.width * 0.4;
    const logoHeight = logoDims.height * 0.4;

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      for (let x = 0; x < width; x += logoWidth + 100) {
        for (let y = 0; y < height; y += logoHeight + 100) {
          page.drawImage(logoImage, {
            x,
            y,
            width: logoWidth,
            height: logoHeight,
            opacity: 0.12,
            rotate: degrees(-45),
          });
        }
      }
    }

    // Add lender image 
if (lender) {
  const lenderImageBuffer = await generateLenderImage(`Submitted to ${lender}`);
  const lenderImage = await watermarkDoc.embedPng(lenderImageBuffer);
  const lenderWidth = width * 0.4;
  const lenderHeight = (lenderWidth / lenderImage.width) * lenderImage.height;

  for (let i = 0; i < pages.length; i++) {
    pages[i].drawImage(lenderImage, {
      x: width - lenderWidth - 20,
      y: height - lenderHeight - 20,
      width: lenderWidth,
      height: lenderHeight,
      opacity: 0.25,
    });
  }
}
    const watermarkPdfBytes = await watermarkDoc.save();
    const updatedPagesUsed = usageData.pages_used + numPages;

    await supabase
      .from("usage")
      .update({ pages_used: updatedPagesUsed })
      .eq("user_email", userEmail);

    const base64Pdf = Buffer.from(watermarkPdfBytes).toString("base64");
    res.json({ watermarkedPdf: base64Pdf });
  } catch (err) {
    console.error("Failed to process watermark:", err);
    res.status(500).json({ error: "Failed to process watermark" });
  }
});

app.listen(10000, () => {
  console.log("Watermark API running on port 10000");
});
