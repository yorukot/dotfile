#!/bin/bash

keys=(
    "gnome-theme"
    "gnome-icon"
    "gnome-extensions"
    "zsh"
    "superfile"
    "nvim"
    "wallpaper"
    "vesktop-themes"
    "vesktop-setting"
    "vlc-theme"
    "qbittorrent-theme"
)

values=(
    "$HOME/.themes"
    "$HOME/.icons"
    "$HOME/.local/share/gnome-shell"
    "$HOME/.zshrc"
    "$HOME/.config/superfile"
    "$HOME/.config/nvim"
    "$HOME/Pictures/wallpaper"
    "$HOME/.config/vesktop/themes"
    "$HOME/.config/vesktop/settings"
    "$HOME/Documents/themes/vlc"
    "$HOME/Documents/themes/qbittorrent"
)

green='\033[0;32m'
red='\033[0;31m'
yellow='\033[0;33m'
blue='\033[0;34m'
purple='\033[0;35m'
cyan='\033[0;36m'
white='\033[0;37m'
bright_red='\033[1;31m'
bright_green='\033[1;32m'
bright_yellow='\033[1;33m'
bright_blue='\033[1;34m'
bright_purple='\033[1;35m'
bright_cyan='\033[1;36m'
bright_white='\033[1;37m'
nc='\033[0m'

CURRENT_DIR=$(pwd)

echo -e "🗃 $bright_green|$bright_yellow Your git directory is:$bright_cyan $CURRENT_DIR"
echo -e "🗃 $bright_green|$bright_yellow Start copy all your dotfiles"

for i in "${!keys[@]}"; do
    key=${keys[$i]}
    directory=${values[$i]}
    
    echo -e "🗃 $bright_green|$bright_yellow Start copying$bright_cyan $key $nc"
    
    if [ ! -e "$directory" ]; then
        echo -e "🗃 $bright_green|$bright_yellow Directory doesn't exist:$bright_cyan $directory$bright_yellow, skipping. $nc"
    else
        mkdir $CURRENT_DIR/$key
        cp -r "$directory" "$CURRENT_DIR/$key"
        echo -e "🗃 $bright_green|$bright_yellow Copy successful:$bright_purple $directory $nc"
    fi
done

echo -e "🎉 $bright_green|$bright_yellow Successfully created your dotfiles!"