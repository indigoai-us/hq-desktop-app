@echo off
REM Linker shim used by .cargo/config.toml so `cargo build` works from a
REM plain PowerShell on Windows. Sources the MSVC env (vcvarsall.bat) once
REM per cargo linker invocation, then forwards every arg verbatim to link.exe.
REM
REM Why: VS Build Tools 2022 installs link.exe under
REM   <VS install>\VC\Tools\MSVC\<ver>\bin\<host>\<target>\
REM and that dir is only on PATH after vcvarsall has been sourced. A
REM "Developer PowerShell for VS 2022" sources it at shell launch, but a
REM plain PowerShell (and a stock CI runner shell) does not. This shim
REM closes that gap.
REM
REM VS discovery uses vswhere.exe — the canonical Microsoft locator shipped
REM with every VS 2017+ install — so we find the toolchain wherever it lives
REM regardless of edition (BuildTools/Community/Pro/Enterprise) or install
REM root. A hardcoded edition-path list remains as a fallback. The hardcoded
REM list alone was brittle: GitHub's windows-latest image moved the VS layout
REM and the old search stopped matching, breaking CI on green code.

setlocal enabledelayedexpansion

REM Pick target arch. cargo sets VSCMD_ARG_TGT_ARCH for us when invoked
REM from rustc, but be defensive — fall back to x64 if absent.
if "%VSCMD_ARG_TGT_ARCH%"=="" set VSCMD_ARG_TGT_ARCH=x64

REM Fast path: if link.exe is already on PATH (the job sourced the dev env),
REM use it directly and skip the per-invocation vcvarsall sourcing.
where link.exe >nul 2>nul
if not errorlevel 1 (
  link.exe %*
  exit /b !errorlevel!
)

set "VCVARS="

REM 1) vswhere — finds the latest install carrying the x64 C++ toolset,
REM    regardless of edition/year/install root.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
  for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
    if exist "%%i\VC\Auxiliary\Build\vcvarsall.bat" set "VCVARS=%%i\VC\Auxiliary\Build\vcvarsall.bat"
  )
)

REM 2) Fallback: hardcoded 2022 edition paths under both Program Files roots.
if not defined VCVARS (
  for %%I in (
    "%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
    "%ProgramFiles%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat"
    "%ProgramFiles%\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvarsall.bat"
    "%ProgramFiles%\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvarsall.bat"
    "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
    "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat"
    "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvarsall.bat"
    "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvarsall.bat"
  ) do (
    if not defined VCVARS if exist %%~I set "VCVARS=%%~I"
  )
)

if not defined VCVARS (
  echo [link-msvc] ERROR: could not locate vcvarsall.bat via vswhere or the hardcoded 2022 edition paths. 1>&2
  echo [link-msvc] Install Visual Studio Build Tools 2022 with the "Desktop development with C++" workload. 1>&2
  exit /b 1
)

REM Source vcvarsall quietly. The `>nul` swallows its banner so cargo's
REM build log stays readable.
call "%VCVARS%" %VSCMD_ARG_TGT_ARCH% >nul
if errorlevel 1 (
  echo [link-msvc] ERROR: vcvarsall.bat %VSCMD_ARG_TGT_ARCH% returned errorlevel %errorlevel%. 1>&2
  exit /b %errorlevel%
)

REM Forward all original args to the now-on-PATH link.exe.
link.exe %*
exit /b %errorlevel%
