# Add bounded iOS build attachment

## Why

A confirmed upload can be ready for build selection before the operator has
approved App Review submission. The public App Store Connect relationship
endpoint can attach an already uploaded build to the existing draft independently.

## What Changes

Add local `attach <release-id> --version-id <draft-id>` and a runner method.
Require the existing owned upload-only release, passing acceptance and exact
uploaded Apple build ID. Only an editable manual iOS draft is eligible. Record
one durable attachment intent, confirm through a separate read, and reconcile
repeat invocations without sending another write. Keep ordinary upload/resume and
explicit full publication separate. Use the same release and target locks.
