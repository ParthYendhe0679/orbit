import asyncio
import websockets
import json

async def test():
    uri = "ws://127.0.0.1:8000/ws?username=TestUser2"
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({"action": "start", "asset": "BTC-USD"}))
        count = 0
        while count < 60:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=8)
                data = json.loads(msg)
                t = data.get("type", "?")
                agent = data.get("agent", "")
                message = str(data.get("message", ""))[:150]
                if message:
                    # Replace emojis to avoid print crash
                    safe_msg = message.encode("ascii", "replace").decode("ascii")
                    print(f"[{t}] {agent}: {safe_msg}")
                else:
                    print(f"[{t}] keys={list(data.keys())}")
                count += 1
                if t == "log" and "ERROR" in str(data.get("message", "")):
                    print("ERROR FOUND - stopping")
                    break
            except asyncio.TimeoutError:
                print("Timeout after 8s - no more messages")
                break

asyncio.run(test())
