# Add Harmony version inventory

## Why

Harmony status and preflight require a release type and exact version ID. Before
this change, the standalone client could not discover those selectors.

## What Changes

Expose `listHarmonyReleases` and the existing `store-versions` command for
`appgallery-connect`. They list the supported CN formal and test records returned
by the official API. Exact status, preflight and publication remain separate
operations.
