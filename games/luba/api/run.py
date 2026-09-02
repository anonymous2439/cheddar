import uvicorn

if __name__ == "__main__":
    # Reverse-proxied under /api/luba (see nginx config).
    uvicorn.run("app.main:app", host="127.0.0.1", port=8013, root_path="/api/luba")
