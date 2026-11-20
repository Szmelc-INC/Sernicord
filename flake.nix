{
  description = "Sernicord ~ A Better Vencord+ for devs & serniks: isolated Discord mod sideloader with power-user plugins";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      runtimeDeps = pkgs: with pkgs; [ bash git nodejs pnpm rsync python3 coreutils curl gnutar gzip ];
    in
    {
      packages = forAll (pkgs: rec {
        sernicord = pkgs.stdenvNoCC.mkDerivation {
          pname = "sernicord";
          version = "1.4.0";
          src = self;

          nativeBuildInputs = [ pkgs.makeWrapper pkgs.installShellFiles ];
          dontBuild = true;

          installPhase = ''
            runHook preInstall
            share=$out/share/sernicord
            mkdir -p $share $out/bin
            cp -r plugins scripts configs completions $share/
            install -Dm755 sernicord $share/sernicord
            install -Dm755 dev.sh $share/dev.sh
            install -Dm644 .env.example $share/.env.example
            install -Dm644 .gitignore $share/.gitignore

            substitute packaging/sernicord-wrapper $out/bin/sernicord --replace-fail "@SHARE@" "$share"
            chmod 755 $out/bin/sernicord
            wrapProgram $out/bin/sernicord --prefix PATH : ${pkgs.lib.makeBinPath (runtimeDeps pkgs)}

            installShellCompletion --cmd sernicord \
              --bash completions/sernicord.bash \
              --zsh completions/_sernicord \
              --fish completions/sernicord.fish

            install -Dm644 README.md $out/share/doc/sernicord/README.md
            install -Dm644 plugins/README.md $out/share/doc/sernicord/plugins.md
            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "Isolated Discord mod sideloader (Vencord/Equicord) with Sernicord power-user plugins";
            homepage = "https://github.com/Szmelc-INC/Sernicord";
            license = licenses.gpl3Plus;
            mainProgram = "sernicord";
            platforms = platforms.linux;
          };
        };
        default = sernicord;
      });

      apps = forAll (pkgs: rec {
        sernicord = {
          type = "app";
          program = "${self.packages.${pkgs.system}.sernicord}/bin/sernicord";
        };
        default = sernicord;
      });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = runtimeDeps pkgs ++ [ pkgs.shellcheck pkgs.typescript ];
        };
      });
    };
}
