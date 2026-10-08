use std::time::Duration;

/// Wait until every process has exited or the grace period expires.
///
/// Returns the indexes still alive at the deadline so callers can escalate only
/// those processes. The clock and sleep functions are injected for deterministic
/// tests.
pub fn wait_for_survivors<IsAlive, Now, Sleep>(
    process_count: usize,
    grace: Duration,
    poll_interval: Duration,
    mut is_alive: IsAlive,
    mut now: Now,
    mut sleep: Sleep,
) -> Vec<usize>
where
    IsAlive: FnMut(usize) -> bool,
    Now: FnMut() -> Duration,
    Sleep: FnMut(Duration),
{
    let mut survivors: Vec<_> = (0..process_count).filter(|index| is_alive(*index)).collect();
    if survivors.is_empty() {
        return survivors;
    }

    let deadline = now().saturating_add(grace);
    let poll_interval = poll_interval.max(Duration::from_millis(1));
    while !survivors.is_empty() {
        let current = now();
        if current >= deadline {
            break;
        }
        sleep(poll_interval.min(deadline.saturating_sub(current)));
        survivors.retain(|index| is_alive(*index));
    }
    survivors
}

#[cfg(test)]
mod tests {
    use super::wait_for_survivors;
    use std::cell::Cell;
    use std::time::Duration;

    const GRACE: Duration = Duration::from_secs(9);
    const POLL: Duration = Duration::from_millis(50);

    #[test]
    fn returns_early_when_all_processes_exit() {
        let elapsed = Cell::new(Duration::ZERO);
        let survivors = wait_for_survivors(
            2,
            GRACE,
            POLL,
            |_| elapsed.get() < Duration::from_millis(150),
            || elapsed.get(),
            |duration| elapsed.set(elapsed.get() + duration),
        );

        assert!(survivors.is_empty());
        assert_eq!(elapsed.get(), Duration::from_millis(150));
        assert!(elapsed.get() < GRACE / 2);
    }

    #[test]
    fn returns_only_survivors_at_the_deadline() {
        let elapsed = Cell::new(Duration::ZERO);
        let survivors = wait_for_survivors(
            3,
            GRACE,
            POLL,
            |index| index == 2,
            || elapsed.get(),
            |duration| elapsed.set(elapsed.get() + duration),
        );

        assert_eq!(survivors, vec![2]);
        assert_eq!(elapsed.get(), GRACE);
    }

    #[test]
    fn zero_processes_returns_without_waiting_or_probing() {
        let survivors = wait_for_survivors(
            0,
            GRACE,
            POLL,
            |_| panic!("must not probe when there are no processes"),
            || panic!("must not read the clock when there are no processes"),
            |_| panic!("must not sleep when there are no processes"),
        );

        assert!(survivors.is_empty());
    }
}
