fx_version 'cerulean'
game 'gta5'

name 'mcpb'
author 'fivem-mcp'
description 'fivem-mcp bridge - lets the fivem-mcp MCP server invoke natives, exports and events for automated in-game testing. DEV SERVERS ONLY - keep mcpb_enabled false in production.'
version '0.5.0'

node_version '22'

server_script 'server.js'
client_script 'client.js'
