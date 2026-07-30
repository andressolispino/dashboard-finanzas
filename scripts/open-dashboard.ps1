$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverScript = Join-Path $PSScriptRoot "dashboard_server.py"
$dashboardUrl = $null
$dashboardPort = $null
$serverReady = $false

foreach ($candidatePort in 4173..4183) {
    $candidateUrl = "http://127.0.0.1:$candidatePort"
    try {
        $payload = Invoke-RestMethod `
            -Uri "$candidateUrl/api/dashboard" `
            -TimeoutSec 1
        if ($null -ne $payload.transactions) {
            $dashboardUrl = $candidateUrl
            $dashboardPort = $candidatePort
            $serverReady = $true
            break
        }
    } catch {
        try {
            Invoke-WebRequest `
                -Uri $candidateUrl `
                -UseBasicParsing `
                -TimeoutSec 1 | Out-Null
            continue
        } catch {
            $dashboardUrl = $candidateUrl
            $dashboardPort = $candidatePort
            break
        }
    }
}

if ($null -eq $dashboardPort) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        "No hay un puerto local disponible entre 4173 y 4183.",
        "Dashboard de finanzas"
    ) | Out-Null
    exit 1
}

if (-not $serverReady) {
    $pythonExecutable = Join-Path $projectRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $pythonExecutable)) {
        $pythonExecutable = (Get-Command python.exe -ErrorAction Stop).Source
    }

    Start-Process `
        -FilePath $pythonExecutable `
        -ArgumentList @($serverScript, [string]$dashboardPort) `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden

    for ($attempt = 0; $attempt -lt 24; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $payload = Invoke-RestMethod `
                -Uri "$dashboardUrl/api/dashboard" `
                -TimeoutSec 1
            if ($null -ne $payload.transactions) {
                $serverReady = $true
                break
            }
        } catch {
            $serverReady = $false
        }
    }
}

if (-not $serverReady) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        "No fue posible iniciar el dashboard. Ejecuta npm install y npm run build dentro de la carpeta web.",
        "Dashboard de finanzas"
    ) | Out-Null
    exit 1
}

Start-Process $dashboardUrl
