#!/bin/bash
# Placeholder until your deploy pipeline uploads the real standalone build zip:
# builds/<release>/server/build.zip containing .next/standalone with this run.sh at its root.
# HOSTNAME comes from the function's environment (SssbApp sets 0.0.0.0): leave it out of your run.sh.
exec node server.js
