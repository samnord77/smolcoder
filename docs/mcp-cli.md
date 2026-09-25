# CLI de chaque serveur MCP — gardées ici, à la fin du projet

Copiez une ligne telle quelle dans `.smol/mcp.json` (`command` + `args`)
ou lancez-la à la main pour tester. Clés API : jamais dans un fichier —
passez par vos variables d'environnement (le pont les hérite).

## Console (marchent avec smolcoder)

```text
laya                  C:\Python314\python.exe C:\Users\DELL\AppData\Roaming\Python\Python314\Scripts\mcp_laya.py
code-context-control  C:\Users\DELL\.local\bin\c3-mcp.exe
memory                node C:\Users\DELL\AppData\Roaming\npm\node_modules\@modelcontextprotocol\server-memory\dist\index.js
                      env: MEMORY_FILE_PATH=C:\Users\DELL\.config\opencode\memory.json
sqlite                C:\Users\DELL\.local\bin\mcp-server-sqlite.exe --db-path C:\Users\DELL\.opencode\opencode.db
fetch                 C:\Users\DELL\.local\bin\mcp-server-fetch.exe
windows               node C:\Users\DELL\AppData\Roaming\npm\node_modules\@wonderwhy-er\desktop-commander\dist\index.js
excel                 node C:\Users\DELL\AppData\Roaming\npm\node_modules\@negokaz\excel-mcp-server\dist\launcher.js
                      env: EXCEL_FILES_PATH=C:\Users\DELL\Documents
word                  C:\Users\DELL\.local\bin\word_mcp_server.exe
powerbi               node C:\Users\DELL\AppData\Roaming\npm\node_modules\@microsoft\powerbi-modeling-mcp\index.js --start
firecrawl             node C:\Users\DELL\AppData\Roaming\npm\node_modules\firecrawl-mcp\dist\index.js
                      env: FIRECRAWL_API_KEY=<votre clé, rotation conseillée si exposée>
playwright            node C:\Users\DELL\AppData\Roaming\npm\node_modules\@playwright\mcp\cli.js --headless
websearch             node C:\Users\DELL\AppData\Roaming\npm\node_modules\duckduckgo-mcp-server\build\index.js
sequential-thinking   node C:\Users\DELL\AppData\Roaming\npm\node_modules\@modelcontextprotocol\server-sequential-thinking\dist\index.js
scrapling             C:\Python314\Scripts\scrapling-mcp.exe
youtube-transcripts   C:\Python314\python.exe C:\Users\DELL\.opencode\mcp-youtube\server.py
filesystem            node C:\Users\DELL\AppData\Roaming\npm\node_modules\@modelcontextprotocol\server-filesystem\dist\index.js <dossier>
git                   uvx mcp-server-git --repository <dossier>
```

Sans chemin direct (téléchargés à la demande) :

```text
thinking   npx -y @modelcontextprotocol/server-sequential-thinking
everything npx -y @modelcontextprotocol/server-everything
browser    npx -y @playwright/mcp
n8n        npx -y n8n-mcp   (docs seules sans serveur n8n local ; env: N8N_API_URL)
```

## Distants (incompatibles console — transport HTTP requis)

```text
zapier    https://mcp.zapier.com/api/v1/connect   (Bearer : variable d'environnement, jamais en clair)
deepwiki  https://mcp.deepwiki.com/mcp
```

## Laya

```text
C:\Python314\python.exe C:\Users\DELL\AppData\Roaming\Python\Python314\Scripts\mcp_laya.py
```

Outils : decide, email, guard, health, triage — 100 % local.
État le 2026-09-24 : le processus démarre puis plante aussitôt sur ce PC
(code 3221225477) ; entrée gardée dans `~/.smolcoder/mcp.json`, elle
signale `unreachable` au lieu de bloquer. À retester après mise à jour
du paquet Python.
