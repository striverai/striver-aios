$filePath = 'C:\Users\admin\.claude\projects\D--Project-Javis-OS\c2897e11-53b7-4214-872b-efdb594017e3\tool-results\mcp-claude_ai_Meta_Facebook_Ads-ads_get_ad_entities-1782671706690.txt'
$content = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)
$outer = $content | ConvertFrom-Json
$entities = $outer.ad_entities | ConvertFrom-Json
Write-Output ("Total entities: " + $entities.Count)

$active = @()
foreach ($e in $entities) {
    $spent = $e.amount_spent
    # Skip if null, empty, "Not available", or starts with "0 " (zero amount)
    if ($spent -ne $null -and $spent -ne '' -and $spent -ne 'Not available') {
        # Check if it starts with "0 " which means zero spend
        if (-not ($spent -match '^0\s')) {
            $active += $e
        }
    }
}
Write-Output ("Campaigns with real spend: " + $active.Count)

foreach ($c in $active) {
    Write-Output "---"
    Write-Output ("name: " + $c.name)
    Write-Output ("effective_status: " + $c.effective_status)
    Write-Output ("amount_spent: " + $c.amount_spent)
    Write-Output ("impressions: " + $c.impressions)
    Write-Output ("clicks: " + $c.clicks)
    Write-Output ("ctr: " + $c.ctr)
    Write-Output ("cpc: " + $c.cpc)
    Write-Output ("cpm: " + $c.cpm)
    Write-Output ("reach: " + $c.reach)
    Write-Output ("frequency: " + $c.frequency)
    Write-Output ("results: " + ($c.results | ConvertTo-Json -Compress))
    Write-Output ("cost_per_result: " + ($c.cost_per_result | ConvertTo-Json -Compress))
    Write-Output ("purchase_roas: " + $c.purchase_roas)
}
