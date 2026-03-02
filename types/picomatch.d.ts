declare module "picomatch" {
    type Matcher = (input: string) => boolean;

    function picomatch(pattern: string | string[]): Matcher;

    export default picomatch;
}
