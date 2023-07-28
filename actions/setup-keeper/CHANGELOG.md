# setup-keeper

## 1.2.1

### Patch Changes

-   7435fb8: Update the version of keeper to avoid a communication error

## 1.2.0

### Minor Changes

-   5496ed4: Upgrade keepercommander to 16.5.16

## 1.1.0

### Minor Changes

-   211a2f0: Downgrade keepercommander to 16.5.6 to fix throttling issue

## 1.0.1

### Patch Changes

-   d968fdf: version lock python & pip version that works with keeper installation instead of relying on the python version of the github runner image.

## 1.0.0

### Major Changes

-   945b6d6: Introducing: setup-keeper! If you give it a valid KEEPER_CONFIG as the `config` input, it will set up keeper for you, as well as the env vbl needed so `keeper` commands will work without specifying a config by hand.

### Patch Changes

-   078a776: Use github-script instead of bash heredocs because it seems to work better
