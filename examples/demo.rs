use vstd::prelude::*;

verus! {

broadcast use vstd::seq_lib::group_seq_properties;

// A pure specification function (yellow)
spec fn triangle(n: nat) -> nat
    decreases n,
{
    if n == 0 { 0 } else { n + triangle((n - 1) as nat) }
}

// An axiom-style assumption: external_body proof fn (red)
#[verifier::external_body]
proof fn axiom_triangle_bound(n: nat)
    ensures triangle(n) <= n * n,
{
}

// A proof lemma (grey)
proof fn triangle_is_monotonic(i: nat, j: nat)
    requires i <= j,
    ensures triangle(i) <= triangle(j),
    decreases j,
{
    if i < j {
        triangle_is_monotonic(i, (j - 1) as nat);
    }
}

// Trusted spec for an external function (red)
assume_specification [core::mem::swap::<u64>] (a: &mut u64, b: &mut u64)
    ensures *a == *old(b), *b == *old(a);

// Executable code (default) with specs (yellow) and proofs (grey)
fn triangle_loop(n: u64) -> (sum: u64)
    requires triangle(n as nat) < 0x1_0000_0000,
    ensures sum == triangle(n as nat),
{
    let mut sum: u64 = 0;
    let mut idx: u64 = 0;
    let ghost total = triangle(n as nat);
    while idx < n
        invariant
            idx <= n,
            sum == triangle(idx as nat),
            triangle(n as nat) == total,
            total < 0x1_0000_0000,
        decreases n - idx,
    {
        idx = idx + 1;
        assert(sum + idx <= total) by {
            triangle_is_monotonic(idx as nat, n as nat);
        };
        sum = sum + idx;
        proof {
            assert(sum == triangle(idx as nat));
        }
    }
    sum
}

// An unverified escape hatch (red body marker)
fn compute_fast(n: u64) -> (r: u64)
    ensures r == triangle(n as nat),
{
    assume(n < 100);  // unproven assumption (red)
    let r = n * (n + 1) / 2;
    proof {
        admit();  // giving up on the proof here (red)
    }
    r
}

} // verus!

fn main() {
    let t = triangle_loop(10);
    println!("triangle(10) = {}", t);
}
