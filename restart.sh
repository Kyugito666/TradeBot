#!/bin/bash
export PATH=$PATH:/usr/local/go/bin:/home/kyugito/.cargo/bin
bash start_bot.sh --stop
rm -rf /mnt/d/database/engine/*
bash start_bot.sh
