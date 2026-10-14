{
  description = "TypeScript development environment (nodejs + pnpm)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    agent-skills-nix = {
      url = "github:Kyure-A/agent-skills-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    skills = {
      url = "github:toshiki-higa/skills";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.agent-skills-nix.follows = "agent-skills-nix";
    };
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      agent-skills-nix,
      skills,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        agentLib = agent-skills-nix.lib.agent-skills;
        selectedSkills = [
          "lang/typescript-practice"
        ];
        selection = pkgs.lib.mapAttrs'
          (id: skill: pkgs.lib.nameValuePair (builtins.baseNameOf id) (skill // { id = builtins.baseNameOf id; }))
          (agentLib.selectSkills {
            inherit (skills) sources catalog;
            allowlist = selectedSkills;
          });
        skillsHook = agentLib.mkShellHook {
          inherit pkgs;
          bundle = agentLib.mkBundle { inherit pkgs selection; };
          targets.agents = agentLib.defaultLocalTargets.agents // { enable = true; };
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.pnpm
          ];
          shellHook = ''
            # Install selected skills into .agents/skills (project-local).
            ${skillsHook}
            # Resolve project-local bins/modules.
            export NODE_PATH="$PWD/node_modules"
            export PATH="$NODE_PATH/.bin:$PATH"
            # Only install into physical, project-local modules (never shared links).
            if [ -f pnpm-lock.yaml ] && [ ! -L node_modules ] && [ ! -L node_modules/.pnpm ] && { [ ! -f node_modules/.pnpm/lock.yaml ] || [ pnpm-lock.yaml -nt node_modules/.pnpm/lock.yaml ]; }; then
              echo "Installing dependencies..."
              pnpm install --frozen-lockfile
            fi
          '';
        };
      }
    );
}
