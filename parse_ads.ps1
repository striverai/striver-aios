$filePath = 'C:\Users\admin\.claude\projects\D--Project-Javis-OS\c2897e11-53b7-4214-872b-efdb594017e3\tool-results\mcp-claude_ai_Meta_Facebook_Ads-ads_get_ad_entities-1782671706690.txt'
$content = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)
$outer = $content | ConvertFrom-Json
$entities = $outer.ad_entities | ConvertFrom-Json
Write-Output ("Total entities: " + $entities.Count)

$zeroVND = [char]0x30 + ' ' + [char]0x20AB + ' (VND)'

$active = @()
foreach ($e in $entities) {
    $spent = $e.amount_spent
    if ($spent -ne $zeroVND -and $spent -ne 'Not available' -and $spent -ne $null -and $spent -ne '') {
        $active += $e
    }
}
Write-Output ("Campaigns with spend: " + $active.Count)

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
    Write-Output ("results: " + $c.results)
    Write-Output ("cost_per_result: " + $c.cost_per_result)
    Write-Output ("purchase_roas: " + $c.purchase_roas)
}
