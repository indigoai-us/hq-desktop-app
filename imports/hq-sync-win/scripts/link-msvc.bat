@echo off
REM Linker shim used by .cargo/config.toml so `cargo build` works from a
REM plain PowerShell on Windows. Sources vcvarsall.bat once per cargo
REM invocation, then forwards every arg verbatim to MSVC link.exe.
REM
REM Why: VS Build Tools 2022 installs link.exe under
REM   C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\<ver>\bin\<host>\<target>\
REM and that dir is only on PATH after vcvarsall has been sourced. A
REM "Developer PowerShell for VS 2022" sources it at shell launch, but
REM a plain PowerShell does not. This shim closes that gap.

setlocal enabledelayedexpansion

REM Pick target arch. cargo sets VSCMD_ARG_TGT_ARCH for us when invoked
REM from rustc, but be defensive — fall back to x64 if absent.
if "%VSCMD_ARG_TGT_ARCH%"=="" set VSCMD_ARG_TGT_ARCH=x64

REM Find vcvarsall.bat. Try the BuildTools 2022 install first, then the
REM full VS 2022 Community/Professional/Enterprise installs.
set "VCVARS="
for %%I in (
  "%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
  "%ProgramFiles%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat"
  "%ProgramFiles%\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvarsall.bat"
  "%ProgramFiles%\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvarsall.bat"
) do (
  if exist %%~I (
    set "VCVARS=%%~I"
    goto :found
  )
)

echo [link-msvc] ERROR: could not find vcvarsall.bat under "%ProgramFiles%\Microsoft Visual Studio\2022\*". 1>&2
echo [link-msvc] Install Visual Studio Build Tools 2022 with the "Desktop development with C++" workload. 1>&2
exit /b 1

:found
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
