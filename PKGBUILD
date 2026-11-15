# Maintainer: serainox420 <serainox@gmail.com>
pkgname=sernicord-git
_pkgname=sernicord
pkgver=1.0.0.r0.g0000000
pkgrel=1
pkgdesc="Sernicord ~ A Better Vencord+ for devs & serniks: isolated Discord mod sideloader with power-user plugins"
arch=('any')
url="https://github.com/Szmelc-INC/Sernicord"
license=('GPL-3.0-or-later')
depends=('bash' 'git' 'nodejs' 'pnpm' 'rsync' 'python')
makedepends=('git')
provides=("$_pkgname")
conflicts=("$_pkgname")
source=("$_pkgname::git+$url.git")
sha256sums=('SKIP')

pkgver() {
    cd "$_pkgname"
    local ver
    ver=$(sed -n 's/^VERSION="\(.*\)"/\1/p' sernicord)
    printf '%s.r%s.g%s' "$ver" "$(git rev-list --count HEAD)" "$(git rev-parse --short HEAD)"
}

package() {
    cd "$_pkgname"
    local share="$pkgdir/usr/share/$_pkgname"

    install -dm755 "$share"
    cp -r --no-preserve=ownership plugins scripts configs completions "$share/"
    install -Dm755 sernicord "$share/sernicord"
    install -Dm755 dev.sh "$share/dev.sh"
    install -Dm644 .env.example "$share/.env.example"
    install -Dm644 .gitignore "$share/.gitignore"

    install -dm755 "$pkgdir/usr/bin"
    sed "s|@SHARE@|/usr/share/$_pkgname|" packaging/sernicord-wrapper > "$pkgdir/usr/bin/sernicord"
    chmod 755 "$pkgdir/usr/bin/sernicord"

    install -Dm644 completions/sernicord.bash "$pkgdir/usr/share/bash-completion/completions/sernicord"
    install -Dm644 completions/_sernicord "$pkgdir/usr/share/zsh/site-functions/_sernicord"
    install -Dm644 completions/sernicord.fish "$pkgdir/usr/share/fish/vendor_completions.d/sernicord.fish"

    install -Dm644 README.md "$pkgdir/usr/share/doc/$_pkgname/README.md"
    install -Dm644 plugins/README.md "$pkgdir/usr/share/doc/$_pkgname/plugins.md"
    install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
}
