const http = require('node:http');

const html = `<!doctype html><html><head><title>Contact fixture</title></head><body>
<form id="contact" novalidate><label>Name<input id="name" name="name"></label><button type="submit">Submit</button></form>
<p role="status" id="status"></p><script>
document.querySelector('form').addEventListener('submit', async event => {
  event.preventDefault();
  const response = await fetch('/submit', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:document.querySelector('#name').value})});
  document.querySelector('#status').textContent = (await response.json()).message;
});</script></body></html>`;

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/') { response.setHeader('content-type','text/html'); response.end(html);

 return; }

  if (request.method === 'POST' && request.url === '/submit') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.setHeader('content-type','application/json');

      try {
        const {name} = JSON.parse(body);
        const normalized = Object.prototype.toString.call(name) === '[object String]' ? name.trim() : '';

        if (!normalized || normalized.length > 20) { response.statusCode=400;response.end(JSON.stringify({message:'Name must contain 1 to 20 characters'}));

return; }

        response.end(JSON.stringify({message:'Thank you, '+normalized}));
      } catch { response.statusCode=400; response.end(JSON.stringify({message:'Invalid JSON'})); }
    });

return;
  }

  response.statusCode=404;response.end('Not found');
});

server.listen(Number(process.env.PORT || 41739), '127.0.0.1');

for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>server.close(()=>process.exit(0)));
