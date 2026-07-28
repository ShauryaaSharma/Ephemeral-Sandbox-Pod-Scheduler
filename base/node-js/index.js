const http = require("http");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<h1>Hello from your Node.js sandbox</h1><p>Edit index.js and refresh.</p>");
});

server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
