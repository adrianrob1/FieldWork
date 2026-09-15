[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$SampleRoot = Join-Path $RepositoryRoot 'examples/sample-workspace'
$InitialRoot = Join-Path $SampleRoot 'validation/initial'
$ScratchRoot = Join-Path ([IO.Path]::GetTempPath()) ("fieldwork-sample-" + [guid]::NewGuid().ToString('N'))

function Set-ExactText {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Before,
        [Parameter(Mandatory)] [string] $After
    )

    $Text = [IO.File]::ReadAllText($Path)
    $NewLine = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $Before = $Before.Replace("`n", $NewLine)
    $After = $After.Replace("`n", $NewLine)
    $First = $Text.IndexOf($Before, [StringComparison]::Ordinal)
    $Last = $Text.LastIndexOf($Before, [StringComparison]::Ordinal)
    if ($First -lt 0 -or $First -ne $Last) {
        throw "Expected exactly one match in $Path"
    }
    [IO.File]::WriteAllText($Path, $Text.Replace($Before, $After))
}

function Get-RelativeEntries {
    param(
        [Parameter(Mandatory)] [string] $Root,
        [switch] $ExcludeValidation
    )

    Get-ChildItem -LiteralPath $Root -Recurse -Force | Where-Object {
        $Relative = [IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/')
        -not $ExcludeValidation -or (
            $Relative -ne 'VALIDATION.md' -and
            $Relative -ne 'validation' -and
            -not $Relative.StartsWith('validation/')
        )
    } | ForEach-Object {
        $Relative = [IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/')
        if ($_.PSIsContainer) {
            "directory:$Relative"
        }
        else {
            "file:$Relative"
        }
    } | Sort-Object
}

function Write-FixtureText {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Text,
        [Parameter(Mandatory)] [string] $NewLine
    )

    $Normalized = $Text.Replace("`r`n", "`n").Replace("`r", "`n").Replace("`n", $NewLine)
    [IO.File]::WriteAllText($Path, $Normalized.TrimEnd([char[]] "`r`n") + $NewLine)
}

try {
    New-Item -ItemType Directory -Path $ScratchRoot | Out-Null
    Copy-Item -Path (Join-Path $InitialRoot '*') -Destination $ScratchRoot -Recurse -Force

    $WorkspaceText = [IO.File]::ReadAllText((Join-Path $InitialRoot 'workspace.yml'))
    $FixtureNewLine = if ($WorkspaceText.Contains("`r`n")) { "`r`n" } elseif ($WorkspaceText.Contains("`n")) { "`n" } else { throw 'workspace.yml has no detectable newline.' }

    $RankChat = Join-Path $ScratchRoot 'chats/2026-09-02-rank-diagnostics.md'
    $SharedChat = Join-Path $ScratchRoot 'chats/2026-09-02-shared-curvature.md'
    $SoapProject = Join-Path $ScratchRoot 'projects/soap-bubbles/project.yml'

    # Chat metadata is authoritative for project membership.
    Set-ExactText $RankChat "projects: []" "projects:`n  - project_evon"

    # Detach by editing the same authoritative field.
    Set-ExactText $SharedChat "  - project_evon`n  - project_soap_bubbles" "  - project_evon"

    # Promote the rank chat by creating a project and adding its stable ID to the chat.
    $PromotedRoot = Join-Path $ScratchRoot 'projects/posterior-diagnostics'
    New-Item -ItemType Directory -Path $PromotedRoot | Out-Null
    Write-FixtureText -Path (Join-Path $PromotedRoot 'project.yml') -NewLine $FixtureNewLine -Text @"
id: project_posterior_diagnostics
title: Posterior diagnostics
summary: Follow-up work promoted from an initially unassigned chat.
repositories: []
resources: []
topics:
  - topic_preconditioning
"@
    Write-FixtureText -Path (Join-Path $PromotedRoot 'README.md') -NewLine $FixtureNewLine -Text @"
---
id: summary_posterior_diagnostics
title: Posterior diagnostics
kind: project
project: project_posterior_diagnostics
summary: Routes questions about rank behavior in posterior approximations.
keywords:
  - posterior rank
  - diagnostics
sources:
  - chat_rank_diagnostics
reviewed: 2026-09-02
---

# Posterior diagnostics

This project was promoted from ``chat_rank_diagnostics``. The original chat remains
in the workspace-level ``chats/`` directory.
"@
    Set-ExactText $RankChat "  - project_evon`ntopics:" "  - project_evon`n  - project_posterior_diagnostics`ntopics:"
    Set-ExactText $RankChat "This discussion has not yet been assigned to a project." "This discussion began unassigned, then joined ``project_evon``, now titled`nEvolutionary optimization, and became the basis for the posterior diagnostics project."

    # Rename the project directory and title while preserving its stable ID.
    $RenamedRoot = Join-Path $ScratchRoot 'projects/evolutionary-optimization'
    Move-Item -LiteralPath (Join-Path $ScratchRoot 'projects/evon') -Destination $RenamedRoot
    Set-ExactText (Join-Path $RenamedRoot 'project.yml') "title: EVON" "title: Evolutionary optimization"
    Set-ExactText (Join-Path $RenamedRoot 'README.md') "title: EVON" "title: Evolutionary optimization"
    Set-ExactText (Join-Path $RenamedRoot 'README.md') "# EVON" "# Evolutionary optimization"
    # Relocate a repository stand-in and repair the path relative to project.yml.
    $ArchiveRoot = Join-Path $ScratchRoot 'repositories-archive'
    New-Item -ItemType Directory -Path $ArchiveRoot | Out-Null
    Move-Item -LiteralPath (Join-Path $ScratchRoot 'repositories/soap-bubbles') -Destination $ArchiveRoot
    Set-ExactText $SoapProject "path: ../../repositories/soap-bubbles" "path: ../../repositories-archive/soap-bubbles"

    $ExpectedEntries = @(Get-RelativeEntries -Root $SampleRoot -ExcludeValidation)
    $ActualEntries = @(Get-RelativeEntries -Root $ScratchRoot)
    $EntryDifference = Compare-Object $ExpectedEntries $ActualEntries -CaseSensitive
    if ($EntryDifference) {
        throw "Final tree entries differ:`n$($EntryDifference | Out-String)"
    }

    foreach ($Entry in $ExpectedEntries | Where-Object { $_.StartsWith('file:') }) {
        $Relative = $Entry.Substring(5)
        $ExpectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $SampleRoot $Relative)).Hash
        $ActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $ScratchRoot $Relative)).Hash
        if ($ExpectedHash -ne $ActualHash) {
            throw "Content mismatch: $Relative"
        }
    }

    $RenamedProjectText = [IO.File]::ReadAllText((Join-Path $RenamedRoot 'project.yml'))
    if (-not $RenamedProjectText.Contains('x-sample-note: retained across the rename')) {
        throw 'Rename lost an unknown extension field.'
    }

    Write-Host 'PASS: attach, detach, promote, rename, and repository relocation'
    Write-Host 'PASS: final files and directories exactly match the versioned sample workspace'
    Write-Host 'PASS: stable IDs and unknown fields survive direct edits'
}
finally {
    if (Test-Path -LiteralPath $ScratchRoot) {
        Remove-Item -LiteralPath $ScratchRoot -Recurse -Force
    }
}
