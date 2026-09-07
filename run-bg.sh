export NVM_DIR="$HOME/.nvm"
\."$NVM_DIR/nvm.sh"  # This loads nvm
\."$NVM_DIR/bash_completion"  # This loads nvm bash_completion
nvm install 24
nvm use 24
mkdir -p ./logs; LOG="./logs/mayaspace-$(date +%s).log"; nohup node --harmony-temporal --import tsx src/index.ts > "$LOG" 2>&1 & echo "MayaSpace started in background (pid $!) — log: $LOG"
