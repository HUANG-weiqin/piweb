param(
  [ValidateSet("production", "development")]
  [string]$Mode = "production",
  [switch]$Gui
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$backendHealthUrl = "http://127.0.0.1:31415/health"
$productionUrl = "http://127.0.0.1:31415"
$developmentUrl = "http://127.0.0.1:5173"

function Test-HttpEndpoint {
  param([string]$Uri)

  try {
    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 1
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
  }
  catch {
    return $false
  }
}

function Test-PiWebBackend {
  try {
    $response = Invoke-RestMethod -Uri $backendHealthUrl -TimeoutSec 1
    return $response.ok -eq $true
  }
  catch {
    return $false
  }
}

function Find-RunningPiWebUrl {
  if (-not (Test-PiWebBackend)) {
    return $null
  }

  if (Test-HttpEndpoint $developmentUrl) {
    return $developmentUrl
  }

  if (Test-HttpEndpoint $productionUrl) {
    return $productionUrl
  }

  throw "检测到 Pi Web 后端正在运行，但前端不可用。请先查看并关闭现有服务窗口。"
}

function Assert-LocalToolchain {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) {
    throw "未找到 Node.js。请先安装 Node.js 22.19 或更高版本。"
  }

  $script:npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($null -eq $script:npmCommand) {
    throw "未找到 npm。请重新安装包含 npm 的 Node.js。"
  }

  $nodeVersionText = (& $nodeCommand.Source --version).Trim().TrimStart("v")
  $nodeVersion = $null
  if (-not [Version]::TryParse($nodeVersionText.Split("-")[0], [ref]$nodeVersion)) {
    throw "无法识别 Node.js 版本：$nodeVersionText"
  }
  if ($nodeVersion -lt [Version]"22.19.0") {
    throw "Node.js 版本过低：$nodeVersionText。需要 22.19 或更高版本。"
  }
}

function Invoke-Npm {
  param([string[]]$Arguments)

  & $script:npmCommand.Source @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "npm $($Arguments -join ' ') 执行失败，退出码为 $LASTEXITCODE。"
  }
}

function Install-DependenciesIfNeeded {
  $rootLock = Join-Path $projectRoot "package-lock.json"
  $installedLock = Join-Path $projectRoot "node_modules\.package-lock.json"
  $needsInstall = -not (Test-Path -LiteralPath $installedLock)

  if (-not $needsInstall) {
    $needsInstall = (Get-Item -LiteralPath $rootLock).LastWriteTimeUtc -gt `
      (Get-Item -LiteralPath $installedLock).LastWriteTimeUtc
  }

  if ($needsInstall) {
    Write-Host "正在安装或更新项目依赖..."
    Invoke-Npm @("install")
  }
}

function Start-PiWebProcess {
  param([string]$NpmScript)

  $originalPort = $env:PORT
  try {
    $env:PORT = "31415"
    return Start-Process `
      -FilePath $env:ComSpec `
      -ArgumentList @("/d", "/k", "npm run $NpmScript") `
      -WorkingDirectory $projectRoot `
      -PassThru
  }
  finally {
    if ($null -eq $originalPort) {
      Remove-Item Env:PORT -ErrorAction SilentlyContinue
    }
    else {
      $env:PORT = $originalPort
    }
  }
}

function Wait-ForPiWeb {
  param(
    [System.Diagnostics.Process]$Process,
    [string]$TargetUrl
  )

  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ((Test-PiWebBackend) -and (Test-HttpEndpoint $TargetUrl)) {
      return
    }
    if ($Process.HasExited) {
      throw "服务进程已提前退出，退出码为 $($Process.ExitCode)。"
    }
    Start-Sleep -Milliseconds 500
  }

  throw "服务在 60 秒内没有准备好。请查看 Pi Web 服务窗口中的日志。"
}

try {
  $runningUrl = Find-RunningPiWebUrl
  if ($null -ne $runningUrl) {
    Write-Host "Pi Web 已经在运行，正在打开浏览器..."
    Start-Process $runningUrl
    exit 0
  }

  Assert-LocalToolchain
  Install-DependenciesIfNeeded

  if ($Mode -eq "production") {
    Write-Host "正在构建 Pi Web 生产版本..."
    Invoke-Npm @("run", "build")
    Write-Host "正在启动 Pi Web..."
    $serviceProcess = Start-PiWebProcess "start"
    $targetUrl = $productionUrl
  }
  else {
    Write-Host "正在启动 Pi Web 开发服务..."
    $serviceProcess = Start-PiWebProcess "dev"
    $targetUrl = $developmentUrl
  }

  Write-Host "正在等待服务准备完成..."
  Wait-ForPiWeb -Process $serviceProcess -TargetUrl $targetUrl
  Start-Process $targetUrl
}
catch {
  $message = "启动失败：$($_.Exception.Message)"
  if ($Gui) {
    $shell = New-Object -ComObject WScript.Shell
    $shell.Popup($message, 0, "Pi Web 启动失败", 16) | Out-Null
  }
  else {
    Write-Host ""
    Write-Host $message -ForegroundColor Red
  }
  exit 1
}
