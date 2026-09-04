fx_version 'cerulean'
games { 'gta5' }

name 'mcpb'
author 'fivem-mcp'
description 'fivem-mcp bridge - lets the fivem-mcp MCP server invoke natives, exports and events for automated in-game testing. DEV SERVERS ONLY - keep mcpb_enabled false in production.'
version '0.6.0'
repository 'https://github.com/ziyacivan/fivem-mcp'

server_script 'server.js'
client_script 'client.js'
