import uvicorn

if __name__ == "__main__":
    # Reverse-proxied under /api/karirs (see nginx config) — root_path keeps
    # self-referencing URLs (openapi.json, docs) correct; nginx already
    # strips the prefix before forwarding, so direct localhost access is
    # unaffected.
    uvicorn.run("app.main:app", host="127.0.0.1", port=8010, root_path="/api/karirs")
