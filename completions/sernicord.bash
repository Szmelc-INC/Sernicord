# bash completion for sernicord
_sernicord() {
    local cur prev cmds opts
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    cmds="dev up menu setup sync-plugins build watch inject uninject launch fix update upgrade self-update check rebuild repair reinstall restart logs doctor status stop profiles backup restore scan clean-build completion version help"
    opts="--target --profile --channel --system --no-launch --no-watch --prod --no-color --full --plugins-only --data-only --import --from --no-self --no-build -y --yes -f --follow -h --help -V --version"

    case "$prev" in
        --target) COMPREPLY=($(compgen -W "vencord equicord" -- "$cur")); return ;;
        --channel) COMPREPLY=($(compgen -W "stable ptb canary" -- "$cur")); return ;;
        --profile) return ;;
        completion) COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur")); return ;;
        --import) COMPREPLY=($(compgen -W "settings themes quickcss cache plugins all" -- "$cur")); return ;;
        --from) COMPREPLY=($(compgen -d -- "$cur")); return ;;
        restore) COMPREPLY=($(compgen -f -G '*.zip' -- "$cur")); return ;;
    esac

    if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "$opts" -- "$cur"))
    else
        COMPREPLY=($(compgen -W "$cmds" -- "$cur"))
    fi
}
complete -F _sernicord sernicord
