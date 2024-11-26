const express = require("express");
const multer = require("multer");
const xlsx = require("node-xlsx");
const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cors = require("cors");
const app = express();
require("dotenv").config();
app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: false }));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "./uploads");
  },
  filename: function (req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({ storage });

async function formatFileForAI(filePath) {
  const normalizedFilePath = path.normalize(filePath);
  const extension = path.extname(normalizedFilePath).toLowerCase();

  const fileData = Buffer.from(fs.readFileSync(normalizedFilePath)).toString(
    "base64"
  );

  switch (extension) {
    case ".png":
    case ".jpg":
    case ".jpeg":
      return {
        inlineData: {
          mimeType: "image/jpeg",
          data: fileData,
        },
      };
    case ".pdf":
      return {
        inlineData: {
          mimeType: "application/pdf",
          data: fileData,
        },
      };
    default:
      return [];
  }
}

function processExcelFile(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const workSheetsFromBuffer = xlsx.parse(fileBuffer);

  if (workSheetsFromBuffer.length === 0) {
    return { invoices: [], products: [], customers: [] };
  }

  const sheet = workSheetsFromBuffer[0];
  const jsonData = sheet.data;

  const invoices = [];
  const products = [];
  const customers = [];

  jsonData.slice(1, 16).forEach((row) => {
    const invoiceData = {
      "Serial Number": row[0] || "N/A",
      "Customer Name": row[8] || "N/A",
      "Product Name": row[3] || "N/A",
      Qty: row[4] || "N/A",
      Tax: row[7] || "N/A",
      "Total Amount": row[2] || "N/A",
      Date: row[1] || "N/A",
    };
    invoices.push(invoiceData);

    const productData = {
      "Product Name": row[3] || "N/A",
      Category: null,
      Tax: row[7] || "N/A",
      "Unit Price": row[2] || "N/A",
      "Stock Quantity": row[4] || "N/A",
      "Price with Tax": row[5] || "N/A",
    };
    products.push(productData);

    const customerData = {
      "Customer Name": row[8] || "N/A",
      "Phone Number": row[9] || "N/A",
      "Total Purchase Amount": "N/A",
    };
    customers.push(customerData);
  });

  return {
    invoices,
    products,
    customers,
  };
}

async function geminiOutput(filePath, systemPrompt) {
  const fileInfo = await formatFileForAI(filePath);
  const inputPrompt = systemPrompt;

  try {
    const result = await model.generateContent([inputPrompt, fileInfo]);
    const response = await result.response;
    const text = response.text();
    return text;
  } catch (error) {
    console.error(error);
    throw new Error("Error while extracting customer details from file.");
  }
}

app.post("/upload", upload.single("file"), async (req, res) => {
  const file = req.file;

  if (!file) {
    return res
      .status(400)
      .json({ success: false, message: "No file uploaded." });
  }

  try {
    let fileContent = "";

    if (
      file.mimetype ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      fileContent = processExcelFile(file.path);
      return res.json({
        success: true,
        invoices: fileContent.invoices || [],
        products: fileContent.products || [],
        customers: fileContent.customers || [],
      });
    } else {
      const systemPrompt = `Extract the following information in JSON format:
        - Invoices: { Serial Number, Customer Name, Product Name, Qty, Tax, Total Amount, Date }
        - Products: { Product Name, Category, Unit Price, Tax, Price with Tax, Stock Quantity }
        - Customers: { Customer Name, Phone Number, Total Purchase Amount }
        Ensure the response follows strict JSON formatting.`;

      fileContent = await geminiOutput(file.path, systemPrompt);
    }

    let result = fileContent.replace(/```json|```/g, "").trim();
    result = result.match(/{[\s\S]*}/)?.[0] || result;

    let parsedData = {};
    try {
      parsedData = JSON.parse(result);
    } catch (error) {
      console.error("Error parsing JSON:", error.message);
    }

    fs.unlinkSync(file.path);

    return res.json({
      success: true,
      invoices: parsedData.Invoices || [],
      products: parsedData.Products || [],
      customers: parsedData.Customers || [],
    });
  } catch (error) {
    console.error("Error processing file:", error.message);
    fs.unlinkSync(file.path); // Ensure cleanup
    return res.status(500).json({
      success: false,
      message: "Failed to process the file.",
      error: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
