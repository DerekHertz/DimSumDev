param([ValidateRange(1,410)][int]$DurationSeconds = 410)
$ErrorActionPreference = 'Stop'
$watch = [Diagnostics.Stopwatch]::StartNew()
while ($watch.Elapsed.TotalSeconds -lt $DurationSeconds) {
  $beginMs = $watch.Elapsed.TotalMilliseconds
  $utcBegin = [DateTime]::UtcNow.ToString('o')
  $record = [ordered]@{source='Win32_PerfFormattedData_Counters_ProcessorInformation'; aggregate='_Total'; utcBegin=$utcBegin; monotonicBeginMs=$beginMs; cadenceMs=5000; available=$false; values=[ordered]@{}; missing=@()}
  try {
    $rows = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'")
    if ($rows.Count -eq 1) {
      $record.available = $true
      foreach ($field in @('ProcessorFrequency','PercentProcessorUtility','PercentProcessorPerformance','PercentIdleTime','Timestamp_Sys100NS','Frequency_Sys100NS','Timestamp_PerfTime','Frequency_PerfTime')) {
        $property = $rows[0].PSObject.Properties[$field]
        if (($null -ne $property) -and ($null -ne $property.Value)) { $record.values[$field] = [string]$property.Value } else { $record.missing += $field }
      }
    }
  } catch { $record.available = $false; $record.limitation = 'Aggregate counter query failed; no workaround attempted' }
  $record.monotonicEndMs = $watch.Elapsed.TotalMilliseconds
  $record.utcEnd = [DateTime]::UtcNow.ToString('o')
  $record.queryWallMs = $record.monotonicEndMs - $beginMs
  $record | ConvertTo-Json -Depth 5 -Compress
  $delayMs = [Math]::Max(0, 5000 - ($watch.Elapsed.TotalMilliseconds - $beginMs))
  Start-Sleep -Milliseconds ([int]$delayMs)
}
