const express = require("express");
const app = express();

app.get("/", (_req, res) => {
  res.send("Hello, World!");
});

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});

// Add this middleware for CORS support
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});
