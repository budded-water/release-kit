# Add standalone WeChat Mini Program queries

## Why

A developer upload journal observes a local operation. Operators also need to
read the current experience and production versions, and the state of a
specific or latest review submission directly from WeChat.

## What Changes

Expose WeChat via the standalone store version and status commands and a
programmatic query module. Bind the supplied third-party token to the expected
mini program with the official identity endpoint. Report exact observed coverage
and retain separate review, experience and production facts. Consumer-owned
authorization supplies the short-lived token. Scope the change to read queries.
