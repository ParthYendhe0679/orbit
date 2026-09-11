@echo off
TITLE ORBIT AI Trading Terminal Launcher
echo ============================================================
echo   LAUNCHING ORBIT AI-POWERED TRADING TERMINAL (TypeScript)
echo ============================================================
echo.

REM The Go gateway is required: it authenticates every request. Running the
REM ai-service alone on :8000 would bypass authentication, so there is no fallback.
where go.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Go 1.24+ is required for the gateway and the tick hub. Install it from https://go.dev/dl/
    exit /b 1
)

REM Step 1: Compile TypeScript Bundle
echo [1/5] Building TypeScript frontend bundle...
call npm run build
if errorlevel 1 (
    echo [ERROR] TypeScript compilation failed!
    exit /b 1
)
echo [OK] Frontend bundle ready.
echo.

REM Step 2: Launch TypeScript Watcher in background
echo [2/5] Starting TypeScript file watcher in background...
start "ORBIT TypeScript Watcher" cmd /k "cd /d "%~dp0" && npm run watch"

REM Step 3: orbit-stream tick hub (internal, port 8002)
echo [3/5] Starting orbit-stream tick hub on Port 8002...
start "ORBIT Stream Hub (8002)" cmd /k "cd /d "%~dp0go-stream" && go run . --port 8002"

REM Step 4: Launch Python AI Service (loopback only, port 8001)
echo [4/5] Starting Python AI Service on internal Port 8001 (backend only)...
start "ORBIT AI Service (Internal 8001)" cmd /k "cd /d "%~dp0ai-service" && python -m uvicorn main:app --host 127.0.0.1 --port 8001 --reload"

REM Step 5: Launch Go Backend Gateway (Port 8000)
echo.
echo ============================================================
echo   ORBIT TERMINAL LIVE AT: http://127.0.0.1:8000/
echo ============================================================
echo [5/5] Starting Go Backend Gateway on Port 8000...
start "" "http://127.0.0.1:8000/"
cd /d "%~dp0backend"
go run .

