@echo off
TITLE ORBIT AI Trading Terminal Launcher
echo ============================================================
echo   LAUNCHING ORBIT AI-POWERED TRADING TERMINAL (TypeScript)
echo ============================================================
echo.

REM Step 1: Compile TypeScript Bundle
echo [1/4] Building TypeScript frontend bundle...
call npm run build
if errorlevel 1 (
    echo [ERROR] TypeScript compilation failed!
    exit /b 1
)
echo [OK] Frontend bundle ready.
echo.

REM Step 2: Launch TypeScript Watcher in background
echo [2/4] Starting TypeScript file watcher in background...
start "ORBIT TypeScript Watcher" cmd /k "cd /d "%~dp0" && npm run watch"

REM Step 3: Launch Python AI Service (Port 8001)
echo [3/4] Starting Python AI Service on Port 8001...
start "ORBIT AI Service (8001)" cmd /k "cd /d "%~dp0ai-service" && python -m uvicorn main:app --host 127.0.0.1 --port 8001 --reload"

REM Step 4: Launch Go Backend Gateway (Port 8000)
echo.
echo ============================================================
echo   ORBIT TERMINAL LIVE AT: http://127.0.0.1:8000/
echo ============================================================
echo [4/4] Starting Go Backend Gateway on Port 8000...
where go.exe >nul 2>&1
if not errorlevel 1 (
    cd /d "%~dp0backend"
    go run .
) else (
    echo [WARN] Go compiler not detected. Falling back to direct Python server on port 8000...
    cd /d "%~dp0ai-service"
    python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
)
