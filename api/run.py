import uvicorn

if __name__ == "__main__":
    # root_path tells FastAPI it's reverse-proxied under /api/cheddar (see nginx
    # config), so it generates correct self-referencing URLs — docs, openapi.json,
    # redirects — with that prefix included. It doesn't affect route matching:
    # nginx already strips the prefix before forwarding, and direct access on
    # this port (e.g. local curl/testing) is unaffected.
    uvicorn.run("app.main:app", host="127.0.0.1", port=8008, root_path="/api/cheddar")
