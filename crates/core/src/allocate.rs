/// Distributes `total` over `weights` (`(key, weight)`, weights > 0) in proportion to the weights,
/// in whole cents, using the largest-remainder method so the parts add up exactly to `total`.
/// Parts that round to zero are dropped.
pub(crate) fn allocate(total: i64, weights: &[(i64, i64)]) -> Vec<(i64, i64)> {
    let weight_sum: i128 = weights.iter().map(|&(_, w)| i128::from(w)).sum();
    if total == 0 || weight_sum <= 0 {
        return Vec::new();
    }
    let magnitude = i128::from(total).abs();
    let mut parts: Vec<(usize, i128, i128)> = weights
        .iter()
        .enumerate()
        .map(|(i, &(_, w))| {
            let scaled = magnitude * i128::from(w);
            (i, scaled / weight_sum, scaled % weight_sum)
        })
        .collect();
    let mut leftover = magnitude - parts.iter().map(|p| p.1).sum::<i128>();
    let mut by_remainder: Vec<usize> = (0..parts.len()).collect();
    by_remainder.sort_by(|&a, &b| parts[b].2.cmp(&parts[a].2).then(a.cmp(&b)));
    for i in by_remainder {
        if leftover == 0 {
            break;
        }
        parts[i].1 += 1;
        leftover -= 1;
    }
    let sign = total.signum();
    parts.into_iter().filter(|p| p.1 != 0).map(|(i, amount, _)| (weights[i].0, sign * amount as i64)).collect()
}

#[cfg(test)]
mod tests {
    use super::allocate;

    #[test]
    fn proportional_and_exact() {
        assert_eq!(allocate(5000, &[(1, 30000), (2, 20000)]), vec![(1, 3000), (2, 2000)]);
        assert_eq!(allocate(100, &[(1, 1), (2, 1), (3, 1)]), vec![(1, 34), (2, 33), (3, 33)]);
        assert_eq!(allocate(-100, &[(1, 1), (2, 1), (3, 1)]), vec![(1, -34), (2, -33), (3, -33)]);
        assert_eq!(allocate(1, &[(1, 1), (2, 1)]), vec![(1, 1)]);
    }

    #[test]
    fn nothing_to_spread_over() {
        assert!(allocate(100, &[]).is_empty());
        assert!(allocate(0, &[(1, 5)]).is_empty());
    }
}
